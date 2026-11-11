import { parseSource, fetchMeta, describeSource } from './sources.js';
import { toast, debounce } from './common.js';

const form = document.getElementById('create');
const urlInput = document.getElementById('video-url');
const submit = document.getElementById('create-submit');
const detectLine = document.getElementById('detect-line');
const detectText = document.getElementById('detect-text');
const preview = document.getElementById('link-preview');
const previewImg = document.getElementById('preview-img');
const previewTitle = document.getElementById('preview-title');
const previewMeta = document.getElementById('preview-meta');
const sourceTypeLabel = document.getElementById('source-type-label');
const joinInput = document.getElementById('room-code');
const joinButton = document.getElementById('join-submit');

const DEFAULT_HINT = 'Можно вставить любую ссылку — или создать пустую комнату и выбрать видео позже';

let currentSource = null;
let currentMeta = null;
let metaToken = 0;

/* --------------------------- шапка и анимации --------------------------- */

const header = document.getElementById('header');
const onScroll = () => header.classList.toggle('is-stuck', window.scrollY > 8);
onScroll();
window.addEventListener('scroll', onScroll, { passive: true });

const year = document.getElementById('year');
if (year) year.textContent = String(new Date().getFullYear());

if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.14, rootMargin: '0px 0px -40px' }
  );
  document.querySelectorAll('.reveal').forEach((node) => observer.observe(node));
} else {
  document.querySelectorAll('.reveal').forEach((node) => node.classList.add('is-visible'));
}

/* ---------------------------- разбор ссылки ----------------------------- */

function resetPreview() {
  preview.hidden = true;
  previewImg.removeAttribute('src');
  sourceTypeLabel.textContent = 'YouTube · Vimeo · MP4 · HLS';
}

function setDetect(state, text) {
  detectLine.classList.remove('is-valid', 'is-invalid');
  if (state) detectLine.classList.add(`is-${state}`);
  detectText.textContent = text;
}

function showPreview(source, meta) {
  const title = (meta && meta.title) || `Видео на ${describeSource(source)}`;
  const author = meta && meta.author ? ` · ${meta.author}` : '';
  previewTitle.textContent = title;
  previewMeta.textContent = `${describeSource(source)}${author}`;

  const thumbnail = (meta && meta.thumbnail) || source.thumbnail || '';
  if (thumbnail) {
    previewImg.src = thumbnail;
    previewImg.alt = title;
    previewImg.hidden = false;
  } else {
    previewImg.hidden = true;
  }
  preview.href = source.url;
  preview.hidden = false;
}

function handleInput() {
  const raw = urlInput.value.trim();
  currentSource = null;
  currentMeta = null;
  resetPreview();

  if (!raw) {
    setDetect('', DEFAULT_HINT);
    return;
  }

  const source = parseSource(raw);
  if (!source) {
    setDetect('invalid', 'Пока не похоже на ссылку. Проверьте адрес — он должен начинаться с https://');
    return;
  }

  currentSource = source;
  sourceTypeLabel.textContent = describeSource(source).toUpperCase();
  showPreview(source, null);

  if (source.syncable) {
    setDetect('valid', `${describeSource(source)} распознан — плеер будет синхронизирован`);
  } else {
    setDetect('valid', `${describeSource(source)}: встроенный плеер. Управлять им придётся вручную, чат будет работать`);
  }

  const token = ++metaToken;
  fetchMeta(source).then((meta) => {
    if (token !== metaToken || !currentSource) return;
    currentMeta = meta;
    if (meta) showPreview(source, meta);
  });
}

urlInput.addEventListener('input', debounce(handleInput, 260));
urlInput.addEventListener('paste', () => setTimeout(handleInput, 30));
urlInput.addEventListener('blur', handleInput);

/* --------------------------- создание комнаты --------------------------- */

function shake(node) {
  node.classList.add('is-shaking');
  setTimeout(() => node.classList.remove('is-shaking'), 450);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const raw = urlInput.value.trim();

  if (raw && !currentSource) {
    handleInput();
    setTimeout(() => {
      if (!currentSource) {
        shake(urlInput.closest('.field'));
        urlInput.focus();
        toast('Не удалось распознать ссылку. Проверьте её и попробуйте снова.', 'error');
      }
    }, 40);
    if (!currentSource) return;
  }

  submit.disabled = true;
  const original = submit.innerHTML;
  submit.textContent = 'Создаём комнату…';

  try {
    const response = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: currentSource
          ? { url: currentSource.url, kind: currentSource.kind, title: (currentMeta && currentMeta.title) || '' }
          : null,
        title: currentMeta && currentMeta.title ? currentMeta.title : '',
      }),
    });
    if (!response.ok) throw new Error('http');
    const room = await response.json();
    window.location.href = `/r/${room.id}`;
  } catch {
    submit.disabled = false;
    submit.innerHTML = original;
    toast('Сервер не ответил. Попробуйте ещё раз.', 'error');
  }
});

/* ----------------------------- вход по коду ----------------------------- */

joinInput.addEventListener('input', () => {
  const cleaned = joinInput.value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 6);
  if (joinInput.value !== cleaned) joinInput.value = cleaned;
});

function joinRoom() {
  const code = joinInput.value.trim().toLowerCase();
  if (!/^[a-z0-9]{6}$/.test(code)) {
    shake(joinInput.closest('.field'));
    joinInput.focus();
    toast('Код комнаты — 6 символов. Например: k7m2xp', 'error');
    return;
  }
  window.location.href = `/r/${code}`;
}

joinButton.addEventListener('click', joinRoom);
joinInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    joinRoom();
  }
});

/* ------------------------------- мелочи --------------------------------- */

document.querySelectorAll('a[href="#create"]').forEach((link) => {
  link.addEventListener('click', () => {
    setTimeout(() => urlInput.focus({ preventScroll: true }), 450);
  });
});

const params = new URLSearchParams(location.search);
const joinParam = params.get('join');
if (joinParam) {
  joinInput.value = joinParam.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 6);
  document.getElementById('join').scrollIntoView({ block: 'center' });
  setTimeout(() => joinInput.focus({ preventScroll: true }), 300);
}

if (urlInput && !urlInput.value) {
  urlInput.focus({ preventScroll: true });
}
