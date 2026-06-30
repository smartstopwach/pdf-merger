/* ===========================================================
   Folio — PDF Merger logic
=========================================================== */
(() => {
  'use strict';

  if (window['pdfjsLib']) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  // ---------- State ----------
  const state = {
    files: [],          // { id, file, name, size, pages, rotation, addedAt, arrayBuffer }
    lastDeleted: null,
    sortMode: 'manual',
  };

  // ---------- DOM ----------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const dropZone = $('#dropZone');
  const fileInput = $('#fileInput');
  const fileList = $('#fileList');
  const stackMeta = $('#stackMeta');
  const mergeBar = $('#mergeBar');
  const cardTemplate = $('#fileCardTemplate');
  const toastStack = $('#toastStack');
  const contextMenu = $('#contextMenu');

  // ---------- Helpers ----------
  const uid = () => Math.random().toString(36).slice(2, 10);
  const fmtSize = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };
  const fmtTime = (date) => {
    const diff = (Date.now() - date) / 1000;
    if (diff < 10) return 'just now';
    if (diff < 60) return Math.floor(diff) + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  function toast(message, type = 'info', icon = 'fa-circle-check') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<i class="fa-solid ${icon}"></i><span>${message}</span>`;
    toastStack.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 320);
    }, 3200);
  }

  // ---------- Upload handling ----------
  ['dragenter', 'dragover'].forEach(evt =>
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    })
  );
  ['dragleave', 'drop'].forEach(evt =>
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      if (evt === 'drop') {
        const dt = e.dataTransfer;
        if (dt && dt.files) handleFiles(dt.files);
      }
      dropZone.classList.remove('drag-over');
    })
  );
  dropZone.addEventListener('mousemove', (e) => {
    const rect = dropZone.getBoundingClientRect();
    dropZone.style.setProperty('--mx', `${e.clientX - rect.left}px`);
    dropZone.style.setProperty('--my', `${e.clientY - rect.top}px`);
  });
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

  async function handleFiles(fileListInput) {
    const incoming = Array.from(fileListInput).filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if (!incoming.length) {
      if (fileListInput.length) toast('Please choose PDF files only.', 'error', 'fa-triangle-exclamation');
      return;
    }
    if (state.files.length + incoming.length > 100) {
      toast('You can merge up to 100 files at a time.', 'error', 'fa-triangle-exclamation');
    }
    const room = Math.max(0, 100 - state.files.length);
    const slice = incoming.slice(0, room);

    for (const file of slice) {
      if (file.size > 200 * 1024 * 1024) {
        toast(`${file.name} exceeds the 200 MB limit.`, 'error', 'fa-triangle-exclamation');
        continue;
      }
      const entry = {
        id: uid(),
        file,
        name: file.name.replace(/\.pdf$/i, ''),
        size: file.size,
        pages: null,
        rotation: 0,
        addedAt: Date.now(),
      };
      state.files.push(entry);
      renderCard(entry, true);
      readPageCount(entry);
      renderThumbnail(entry);
    }
    updateMeta();
    saveRecent();
  }

  async function readPageCount(entry) {
    try {
      const buf = await entry.file.arrayBuffer();
      entry._buf = buf;
      const doc = await PDFLib.PDFDocument.load(buf, { ignoreEncryption: true });
      entry.pages = doc.getPageCount();
    } catch (err) {
      entry.pages = '—';
      entry._encrypted = true;
    }
    updateCardMeta(entry);
    updateMeta();
  }

  async function renderThumbnail(entry) {
    try {
      if (!window['pdfjsLib']) return;
      const buf = entry._buf || await entry.file.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: buf.slice(0) });
      const pdf = await loadingTask.promise;
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale: 0.4 });
      const card = document.getElementById(`card-${entry.id}`);
      if (!card) return;
      const canvas = card.querySelector('.thumb-canvas');
      const fallback = card.querySelector('.thumb-fallback');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      canvas.hidden = false;
      fallback.style.display = 'none';
    } catch (err) {
      /* keep fallback icon */
    }
  }

  // ---------- Card rendering ----------
  function renderCard(entry, animate) {
    const node = cardTemplate.content.firstElementChild.cloneNode(true);
    node.id = `card-${entry.id}`;
    node.dataset.id = entry.id;
    node.querySelector('.card-name').textContent = entry.name + '.pdf';
    node.querySelector('.card-name').title = entry.name + '.pdf';
    node.querySelector('.card-size').textContent = fmtSize(entry.size);
    node.querySelector('.card-time').textContent = fmtTime(entry.addedAt);
    node.querySelector('.card-pages').textContent = entry.pages ? `${entry.pages} pages` : '… pages';
    fileList.appendChild(node);

    node.querySelectorAll('.card-icon-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleCardAction(entry.id, btn.dataset.action, btn);
      });
    });
    node.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, entry.id);
    });
  }

  function updateCardMeta(entry) {
    const card = document.getElementById(`card-${entry.id}`);
    if (!card) return;
    card.querySelector('.card-pages').textContent = entry.pages ? `${entry.pages} pages` : '— pages';
    const lock = card.querySelector('.lock-badge');
    lock.style.display = entry._encrypted ? 'flex' : 'none';
    const rotIndicator = card.querySelector('.rotate-indicator');
    rotIndicator.hidden = entry.rotation % 360 === 0;
  }

  function handleCardAction(id, action, btnEl) {
    const entry = state.files.find(f => f.id === id);
    if (!entry) return;
    if (action === 'delete') return deleteFile(id);
    if (action === 'duplicate') return duplicateFile(id);
    if (action === 'rotate') return rotateFile(id);
    if (action === 'more') {
      const rect = btnEl.getBoundingClientRect();
      openContextMenu(rect.left, rect.bottom + 6, id);
    }
  }

  function deleteFile(id, silent) {
    const idx = state.files.findIndex(f => f.id === id);
    if (idx === -1) return;
    const [removed] = state.files.splice(idx, 1);
    state.lastDeleted = { entry: removed, index: idx };
    $('#undoDelete').disabled = false;
    const card = document.getElementById(`card-${id}`);
    if (card) {
      card.classList.add('removing');
      setTimeout(() => card.remove(), 280);
    }
    updateMeta();
    saveRecent();
    if (!silent) toast(`Removed ${removed.name}.pdf`, 'info', 'fa-trash-can');
  }

  function duplicateFile(id) {
    const entry = state.files.find(f => f.id === id);
    if (!entry) return;
    const copy = { ...entry, id: uid(), name: entry.name + ' copy', addedAt: Date.now() };
    const idx = state.files.findIndex(f => f.id === id);
    state.files.splice(idx + 1, 0, copy);
    renderCard(copy, true);
    const original = document.getElementById(`card-${id}`);
    const node = document.getElementById(`card-${copy.id}`);
    if (original && node) original.after(node);
    updateCardMeta(copy);
    renderThumbnail(copy);
    updateMeta();
    saveRecent();
    toast(`Duplicated ${entry.name}.pdf`, 'success', 'fa-copy');
  }

  function rotateFile(id) {
    const entry = state.files.find(f => f.id === id);
    if (!entry) return;
    entry.rotation = (entry.rotation + 90) % 360;
    updateCardMeta(entry);
    const card = document.getElementById(`card-${id}`);
    if (card) {
      const canvas = card.querySelector('.thumb-canvas');
      canvas.style.transform = `rotate(${entry.rotation}deg)`;
    }
  }

  function openContextMenu(x, y, id) {
    contextMenu.hidden = false;
    contextMenu.style.left = Math.min(x, window.innerWidth - 190) + 'px';
    contextMenu.style.top = Math.min(y, window.innerHeight - 180) + 'px';
    contextMenu.dataset.target = id;
  }
  document.addEventListener('click', () => { contextMenu.hidden = true; });
  contextMenu.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    const id = contextMenu.dataset.target;
    const action = li.dataset.action;
    if (action === 'rename') {
      const entry = state.files.find(f => f.id === id);
      const name = prompt('Rename file', entry.name);
      if (name) {
        entry.name = name;
        document.querySelector(`#card-${id} .card-name`).textContent = name + '.pdf';
      }
    } else {
      handleCardAction(id, action);
    }
  });

  // ---------- Sorting ----------
  Sortable.create(fileList, {
    handle: '.drag-handle',
    animation: 220,
    easing: 'cubic-bezier(.22,1,.36,1)',
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    forceFallback: false,
    scroll: true,
    onEnd: () => {
      const order = $$('.file-card').map(c => c.dataset.id);
      state.files.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      saveRecent();
    }
  });

  $('#sortAlpha').addEventListener('click', () => {
    state.files.sort((a, b) => a.name.localeCompare(b.name));
    reflow();
    toast('Sorted alphabetically', 'info', 'fa-arrow-down-a-z');
  });
  $('#sortRecent').addEventListener('click', () => {
    state.files.sort((a, b) => a.addedAt - b.addedAt);
    reflow();
    toast('Sorted by upload time', 'info', 'fa-clock');
  });
  $('#reverseOrder').addEventListener('click', () => {
    state.files.reverse();
    reflow();
    toast('Order reversed', 'info', 'fa-arrow-right-arrow-left');
  });
  $('#clearAll').addEventListener('click', () => {
    if (!state.files.length) return;
    if (!confirm('Remove all files from the stack?')) return;
    state.files = [];
    fileList.innerHTML = '';
    updateMeta();
    saveRecent();
    toast('Stack cleared', 'info', 'fa-trash-can');
  });
  $('#undoDelete').addEventListener('click', undoDelete);

  function undoDelete() {
    if (!state.lastDeleted) return;
    const { entry, index } = state.lastDeleted;
    state.files.splice(index, 0, entry);
    reflow();
    state.lastDeleted = null;
    $('#undoDelete').disabled = true;
    toast(`Restored ${entry.name}.pdf`, 'success', 'fa-rotate-left');
  }

  function reflow() {
    fileList.innerHTML = '';
    state.files.forEach(entry => {
      renderCard(entry, false);
      updateCardMeta(entry);
      renderThumbnail(entry);
    });
    updateMeta();
  }

  // ---------- Meta / merge bar ----------
  function updateMeta() {
    const count = state.files.length;
    stackMeta.hidden = count === 0;
    mergeBar.hidden = count === 0;
    $('#fileCount').textContent = count;
    $('#mergeFileCount').textContent = count;
    $('#totalSize').textContent = fmtSize(state.files.reduce((s, f) => s + f.size, 0));
    const pages = state.files.reduce((s, f) => s + (typeof f.pages === 'number' ? f.pages : 0), 0);
    $('#pageCount').textContent = pages;
  }

  // ---------- localStorage recent ----------
  function saveRecent() {
    try {
      const recent = state.files.map(f => ({ name: f.name, size: f.size, addedAt: f.addedAt }));
      localStorage.setItem('folio-recent', JSON.stringify(recent));
    } catch (e) { /* ignore quota */ }
  }

  // ---------- Settings panel ----------
  const settingsPanel = $('#settingsPanel');
  const scrim = $('#settingsScrim');
  function openSettings() { settingsPanel.classList.add('open'); scrim.classList.add('open'); }
  function closeSettings() { settingsPanel.classList.remove('open'); scrim.classList.remove('open'); }
  $('#settingsToggle').addEventListener('click', openSettings);
  $('#settingsClose').addEventListener('click', closeSettings);
  scrim.addEventListener('click', closeSettings);

  let compression = 'none';
  $('#compressionSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    $$('#compressionSeg .seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    compression = btn.dataset.val;
  });

  // theme
  function setTheme(mode) {
    document.documentElement.dataset.theme = mode;
    $('#themeToggle i').className = mode === 'dark' ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
    $$('#themeSeg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.val === mode));
    localStorage.setItem('folio-theme', mode);
  }
  $('#themeToggle').addEventListener('click', () => {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
  $('#themeSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (btn) setTheme(btn.dataset.val);
  });
  setTheme(localStorage.getItem('folio-theme') || 'dark');

  // animations toggle
  $('#animToggle').addEventListener('change', (e) => {
    document.body.dataset.anim = e.target.checked ? 'on' : 'off';
  });

  // ---------- Keyboard shortcuts ----------
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undoDelete(); }
    if (mod && e.key === 'Enter') { e.preventDefault(); if (state.files.length) mergePDFs(); }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'x') { e.preventDefault(); $('#clearAll').click(); }
  });

  // ---------- Ripple on primary buttons ----------
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.primary-btn');
    if (!btn) return;
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
    btn.appendChild(ripple);
    setTimeout(() => ripple.remove(), 650);
  });

  // ---------- Merge process ----------
  const progressModal = $('#progressModal');
  const successModal = $('#successModal');
  const ringFg = $('#progressRingFg');
  const RING_CIRC = 2 * Math.PI * 52;
  ringFg.style.strokeDasharray = RING_CIRC;

  function setProgress(pct, stepIndex, title, sub) {
    ringFg.style.strokeDashoffset = RING_CIRC - (RING_CIRC * pct) / 100;
    $('#progressPercent').textContent = Math.round(pct) + '%';
    $('#progressStepTitle').textContent = title;
    $('#progressStepSub').textContent = sub;
    $$('.pstep').forEach(el => {
      const n = Number(el.dataset.step);
      el.classList.toggle('active', n === stepIndex);
      el.classList.toggle('done', n < stepIndex);
    });
  }

  let mergedBytes = null;
  let mergedFilename = 'merged-document.pdf';

  $('#mergeBtn').addEventListener('click', mergePDFs);
  $('#mergeAnotherBtn').addEventListener('click', () => {
    successModal.hidden = true;
    successModal.style.display = 'none';
  });
  $('#downloadBtn').addEventListener('click', () => {
    if (!mergedBytes) return;
    const blob = new Blob([mergedBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = mergedFilename;
    a.click();
    URL.revokeObjectURL(url);
  });

  async function mergePDFs() {
    if (!state.files.length) return;
    progressModal.hidden = false;
    progressModal.style.display = 'flex';
    const t0 = performance.now();
    try {
      setProgress(8, 1, 'Reading PDFs', 'Opening each file and checking its pages…');
      const merged = await PDFLib.PDFDocument.create();
      const keepMeta = $('#keepMetadata').checked;
      let firstDoc = null;

      for (let i = 0; i < state.files.length; i++) {
        const entry = state.files[i];
        const buf = entry._buf || await entry.file.arrayBuffer();
        const src = await PDFLib.PDFDocument.load(buf, { ignoreEncryption: true });
        if (!firstDoc) firstDoc = src;
        const pct = 8 + (i / state.files.length) * 35;
        setProgress(pct, 1, 'Reading PDFs', `Opened ${entry.name}.pdf (${i + 1}/${state.files.length})`);

        const indices = src.getPageIndices();
        const copied = await merged.copyPages(src, indices);
        copied.forEach(p => {
          if (entry.rotation) {
            const current = p.getRotation().angle || 0;
            p.setRotation(PDFLib.degrees(current + entry.rotation));
          }
          merged.addPage(p);
        });

        await new Promise(r => setTimeout(r, 60)); // smooth UI pacing
      }

      setProgress(50, 2, 'Merging', 'Stitching every page into one document…');
      await new Promise(r => setTimeout(r, 350));

      if (keepMeta && firstDoc) {
        try {
          const title = firstDoc.getTitle();
          const author = firstDoc.getAuthor();
          if (title) merged.setTitle(title);
          if (author) merged.setAuthor(author);
        } catch (e) { /* ignore */ }
      }
      merged.setProducer('Folio');
      merged.setCreationDate(new Date());

      setProgress(75, 3, 'Optimizing', compression === 'none' ? 'Preserving full original quality…' : 'Compressing where possible…');
      await new Promise(r => setTimeout(r, 350));

      const saveOpts = compression === 'none'
        ? { useObjectStreams: true }
        : { useObjectStreams: true, addDefaultPage: false };
      const bytes = await merged.save(saveOpts);

      setProgress(95, 4, 'Ready', 'Wrapping up…');
      await new Promise(r => setTimeout(r, 250));
      setProgress(100, 4, 'Ready', 'Your document is bound.');
      await new Promise(r => setTimeout(r, 350));

      mergedBytes = bytes;
      const outName = ($('#outputName').value || 'merged-document').trim();
      mergedFilename = outName.toLowerCase().endsWith('.pdf') ? outName : outName + '.pdf';

      progressModal.hidden = true;
      progressModal.style.display = 'none';
      showSuccess(merged.getPageCount(), bytes.length, (performance.now() - t0) / 1000);
    } catch (err) {
      console.error(err);
      progressModal.hidden = true;
      progressModal.style.display = 'none';
      toast('Something went wrong while merging. Check that all files are valid PDFs.', 'error', 'fa-triangle-exclamation');
    }
  }

  function showSuccess(pages, size, seconds) {
    $('#successPages').textContent = pages;
    $('#successSize').textContent = fmtSize(size);
    $('#successTime').textContent = seconds.toFixed(1) + 's';
    successModal.hidden = false;
    successModal.style.display = 'flex';
    fireConfetti();
    toast('Merge completed successfully', 'success', 'fa-circle-check');
  }

  // ---------- Confetti ----------
  function fireConfetti() {
    const canvas = $('#confettiCanvas');
    const modal = canvas.closest('.modal');
    const rect = modal.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    const ctx = canvas.getContext('2d');
    const colors = ['#E8B454', '#8B7CF6', '#4DD9C0', '#4DD9A8', '#F0685A'];
    const pieces = Array.from({ length: 90 }, () => ({
      x: canvas.width / 2,
      y: 20,
      vx: (Math.random() - 0.5) * 9,
      vy: Math.random() * -7 - 2,
      size: Math.random() * 6 + 4,
      color: colors[Math.floor(Math.random() * colors.length)],
      rot: Math.random() * 360,
      vr: (Math.random() - 0.5) * 14,
      gravity: 0.25 + Math.random() * 0.08,
    }));
    let frame = 0;
    function tick() {
      frame++;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      pieces.forEach(p => {
        p.vy += p.gravity;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rot * Math.PI) / 180);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      });
      if (frame < 110) requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    requestAnimationFrame(tick);
  }

  // ---------- Init ----------
  progressModal.hidden = true;
  progressModal.style.display = 'none';
  successModal.hidden = true;
  successModal.style.display = 'none';
  updateMeta();
})();
