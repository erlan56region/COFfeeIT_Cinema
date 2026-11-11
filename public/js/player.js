/* Универсальный плеер: YouTube, Vimeo, прямые файлы, HLS и iframe-фолбэк. */

import { loadScript } from './common.js';

function ensureYouTubeAPI() {
  if (window.YT && typeof window.YT.Player === 'function') return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === 'function') {
        try {
          previous();
        } catch {
          /* ignore */
        }
      }
      done();
    };

    const waitReady = () => {
      if (window.YT && typeof window.YT.Player === 'function') done();
      else if (window.YT && typeof window.YT.ready === 'function') window.YT.ready(done);
    };

    loadScript('https://www.youtube.com/iframe_api')
      .then(waitReady)
      .catch(() => fail(new Error('YouTube API недоступен')));
    setTimeout(() => fail(new Error('YouTube API не ответил')), 14000);
  });
}

/* ------------------------------------------------------------------ */
/* Адаптеры                                                            */
/* ------------------------------------------------------------------ */

class BaseAdapter {
  constructor(player, source) {
    this.player = player;
    this.source = source;
    this.time = 0;
    this.duration = 0;
    this.ready = false;
    this.destroyed = false;
  }
  emitUser(action) {
    this.player.emitUser(action);
  }
  getTime() {
    return this.time;
  }
  getDuration() {
    return this.duration;
  }
  play() {
    return Promise.resolve();
  }
  pause() {}
  seek() {}
  isPaused() {
    return true;
  }
  destroy() {
    this.destroyed = true;
  }
}

class Html5Adapter extends BaseAdapter {
  constructor(player, source) {
    super(player, source);
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.controls = true;
    this.video.preload = 'metadata';
    this.video.crossOrigin = 'anonymous';
    if (source.kind === 'audio') {
      this.video.dataset.audio = 'true';
    }
    if (source.kind !== 'hls') this.video.src = source.embedUrl;
    this.player.stage.appendChild(this.video);

    this.hls = null;

    this.onPlay = () => this.emitUser({ type: 'play', time: this.video.currentTime });
    this.onPause = () => {
      if (this.video.ended) return;
      this.emitUser({ type: 'pause', time: this.video.currentTime });
    };
    this.onSeeked = () =>
      this.emitUser({ type: 'seek', time: this.video.currentTime, playing: !this.video.paused && !this.video.ended });
    this.onTime = () => {
      this.time = this.video.currentTime;
      this.duration = Number.isFinite(this.video.duration) ? this.video.duration : this.duration;
      this.player.handlers.onProgress &&
        this.player.handlers.onProgress({ time: this.time, duration: this.duration });
    };
    this.onLoaded = () => {
      this.duration = Number.isFinite(this.video.duration) ? this.video.duration : 0;
      if (!this.ready) {
        this.ready = true;
        this.player.handlers.onReady && this.player.handlers.onReady({ duration: this.duration });
      }
    };
    this.onError = () => {
      if (!this.video.currentSrc && !this.video.getAttribute('src')) return;
      this.player.fail('Не удалось воспроизвести файл. Возможно, ссылка устарела или сервер запрещает воспроизведение.');
    };

    this.video.addEventListener('play', this.onPlay);
    this.video.addEventListener('pause', this.onPause);
    this.video.addEventListener('seeked', this.onSeeked);
    this.video.addEventListener('timeupdate', this.onTime);
    this.video.addEventListener('durationchange', this.onLoaded);
    this.video.addEventListener('loadedmetadata', this.onLoaded);
    this.video.addEventListener('error', this.onError);

    if (source.kind === 'hls') this.setupHls();
  }

  async setupHls() {
    const url = this.source.embedUrl;
    const canNative = this.video.canPlayType('application/vnd.apple.mpegurl');
    try {
      await loadScript('/vendor/hls.light.min.js');
      if (this.destroyed) return;
      if (window.Hls && window.Hls.isSupported()) {
        this.hls = new window.Hls({ enableWorker: true, lowLatencyMode: true });
        this.hls.loadSource(url);
        this.hls.attachMedia(this.video);
        this.hls.on(window.Hls.Events.ERROR, (_event, data) => {
          if (data && data.fatal) {
            this.player.fail('HLS-поток не открылся. Проверьте ссылку или CORS на стороне сервера.');
          }
        });
      } else if (canNative) {
        this.video.src = url;
      } else {
        this.player.fail('Браузер не поддерживает HLS. Попробуйте другой формат или Chrome/Firefox.');
      }
    } catch {
      if (canNative) this.video.src = url;
      else this.player.fail('Не удалось загрузить HLS-плеер.');
    }
  }

  getTime() {
    return this.video.currentTime || 0;
  }
  getDuration() {
    return Number.isFinite(this.video.duration) ? this.video.duration : 0;
  }
  isPaused() {
    return this.video.paused;
  }
  play() {
    const promise = this.video.play();
    return promise && typeof promise.catch === 'function' ? promise : Promise.resolve();
  }
  pause() {
    this.video.pause();
  }
  seek(time) {
    try {
      this.video.currentTime = Math.max(0, time);
    } catch {
      /* ignore */
    }
  }
  destroy() {
    this.destroyed = true;
    this.video.removeEventListener('play', this.onPlay);
    this.video.removeEventListener('pause', this.onPause);
    this.video.removeEventListener('seeked', this.onSeeked);
    this.video.removeEventListener('timeupdate', this.onTime);
    this.video.removeEventListener('durationchange', this.onLoaded);
    this.video.removeEventListener('loadedmetadata', this.onLoaded);
    this.video.removeEventListener('error', this.onError);
    if (this.hls) {
      try {
        this.hls.destroy();
      } catch {
        /* ignore */
      }
    }
    this.video.pause();
    this.video.removeAttribute('src');
    try {
      this.video.load();
    } catch {
      /* ignore */
    }
    this.video.remove();
  }
}

class YouTubeAdapter extends BaseAdapter {
  constructor(player, source) {
    super(player, source);
    this.state = -1;
    this.host = document.createElement('div');
    this.host.className = 'player-embed';
    this.player.stage.appendChild(this.host);
    this.poll = null;
    this.init(source);
  }

  async init(source) {
    try {
      await ensureYouTubeAPI();
      if (this.destroyed) return;
      const origin = encodeURIComponent(location.origin);
      this.yt = new window.YT.Player(this.host, {
        videoId: source.id,
        playerVars: {
          autoplay: 0,
          controls: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          origin,
          enablejsapi: 1,
        },
        events: {
          onReady: () => {
            if (this.destroyed) return;
            this.ready = true;
            this.duration = this.yt.getDuration() || 0;
            this.player.handlers.onReady && this.player.handlers.onReady({ duration: this.duration });
            this.startPolling();
          },
          onStateChange: (event) => this.onStateChange(event.data),
          onError: (event) => this.onError(event.data),
        },
      });
    } catch (error) {
      this.player.fail('YouTube не загрузился. Проверьте блокировщики и подключение к интернету.');
      console.warn('[cinema] youtube:', error);
    }
  }

  startPolling() {
    this.lastTime = 0;
    this.lastTick = performance.now();
    this.poll = setInterval(() => {
      if (this.destroyed || !this.yt || typeof this.yt.getCurrentTime !== 'function') return;
      const now = performance.now();
      const current = this.yt.getCurrentTime() || 0;
      this.time = current;
      this.duration = this.yt.getDuration() || this.duration;
      const state = this.yt.getPlayerState();
      if (state === 1) {
        const expected = this.lastTime + (now - this.lastTick) / 1000;
        if (Math.abs(current - expected) > 2) {
          this.emitUser({ type: 'seek', time: current, playing: true });
        }
      } else if (Math.abs(current - this.lastTime) > 1.5) {
        this.emitUser({ type: 'seek', time: current, playing: state === 1 });
      }
      this.lastTime = current;
      this.lastTick = now;
      this.player.handlers.onProgress &&
        this.player.handlers.onProgress({ time: current, duration: this.duration });
    }, 500);
  }

  onStateChange(state) {
    this.state = state;
    const time = this.getTime();
    if (state === 1) this.emitUser({ type: 'play', time });
    else if (state === 2) this.emitUser({ type: 'pause', time });
    else if (state === 0) this.emitUser({ type: 'seek', time, playing: false });
  }

  onError(code) {
    const messages = {
      2: 'Ссылка на видео некорректна.',
      5: 'Встроенный плеер YouTube не поддерживается браузером.',
      100: 'Видео не найдено или удалено.',
      101: 'Автор запретил встраивать это видео. Откройте его на YouTube или выберите другое.',
      150: 'Автор запретил встраивать это видео. Откройте его на YouTube или выберите другое.',
    };
    this.player.fail(messages[code] || 'YouTube не смог открыть видео.');
  }

  getTime() {
    try {
      if (this.yt && typeof this.yt.getCurrentTime === 'function') return this.yt.getCurrentTime() || 0;
    } catch {
      /* ignore */
    }
    return this.time || 0;
  }
  getDuration() {
    try {
      if (this.yt && typeof this.yt.getDuration === 'function') return this.yt.getDuration() || 0;
    } catch {
      /* ignore */
    }
    return this.duration || 0;
  }
  isPaused() {
    return this.state !== 1;
  }
  play() {
    try {
      this.yt.playVideo();
    } catch {
      /* ignore */
    }
    return Promise.resolve();
  }
  pause() {
    try {
      this.yt.pauseVideo();
    } catch {
      /* ignore */
    }
  }
  seek(time) {
    try {
      this.yt.seekTo(Math.max(0, time), true);
    } catch {
      /* ignore */
    }
  }
  destroy() {
    this.destroyed = true;
    clearInterval(this.poll);
    try {
      if (this.yt && typeof this.yt.destroy === 'function') this.yt.destroy();
    } catch {
      /* ignore */
    }
    this.host.remove();
  }
}

class VimeoAdapter extends BaseAdapter {
  constructor(player, source) {
    super(player, source);
    this.state = 'paused';
    this.iframe = document.createElement('iframe');
    this.iframe.src = source.embedUrl;
    this.iframe.allow = 'autoplay; fullscreen; picture-in-picture';
    this.iframe.setAttribute('allowfullscreen', '');
    this.iframe.setAttribute('title', 'Vimeo');
    this.player.stage.appendChild(this.iframe);
    this.init();
  }

  async init() {
    try {
      await loadScript('/vendor/vimeo-player.min.js');
      if (this.destroyed) return;
      const Vimeo = window.Vimeo;
      if (!Vimeo || !Vimeo.Player) throw new Error('no player');
      this.vimeo = new Vimeo.Player(this.iframe);
      this.vimeo.on('playing', () => {
        this.state = 'playing';
        this.emitUser({ type: 'play', time: this.getTime() });
      });
      this.vimeo.on('pause', () => {
        this.state = 'paused';
        this.emitUser({ type: 'pause', time: this.getTime() });
      });
      this.vimeo.on('seeked', (data) => {
        const playing = this.state === 'playing';
        this.emitUser({ type: 'seek', time: (data && data.seconds) || this.getTime(), playing });
      });
      this.vimeo.on('timeupdate', (data) => {
        if (!data) return;
        this.time = data.seconds || 0;
        this.duration = data.duration || this.duration;
        if (data.percent >= 0.999) this.state = 'paused';
        this.player.handlers.onProgress &&
          this.player.handlers.onProgress({ time: this.time, duration: this.duration });
      });
      this.vimeo.on('ended', () => {
        this.state = 'paused';
        this.emitUser({ type: 'seek', time: this.duration, playing: false });
      });
      await this.vimeo.ready();
      if (this.destroyed) return;
      this.ready = true;
      this.duration = await this.vimeo.getDuration().catch(() => 0);
      this.player.handlers.onReady && this.player.handlers.onReady({ duration: this.duration });
    } catch (error) {
      this.player.fail('Vimeo не открылся. Возможно, видео приватное или запрещено встраивание.');
      console.warn('[cinema] vimeo:', error);
    }
  }

  getTime() {
    return this.time || 0;
  }
  getDuration() {
    return this.duration || 0;
  }
  isPaused() {
    return this.state !== 'playing';
  }
  play() {
    if (!this.vimeo) return Promise.resolve();
    return this.vimeo.play().catch(() => {});
  }
  pause() {
    if (!this.vimeo) return;
    this.vimeo.pause().catch(() => {});
  }
  seek(time) {
    if (!this.vimeo) return;
    this.time = Math.max(0, time);
    this.vimeo.setCurrentTime(Math.max(0, time)).catch(() => {});
  }
  destroy() {
    this.destroyed = true;
    try {
      if (this.vimeo) this.vimeo.destroy();
    } catch {
      /* ignore */
    }
    this.iframe.remove();
  }
}

class IframeAdapter extends BaseAdapter {
  constructor(player, source) {
    super(player, source);
    this.iframe = document.createElement('iframe');
    this.iframe.src = source.embedUrl;
    this.iframe.allow = 'autoplay; fullscreen; picture-in-picture; encrypted-media';
    this.iframe.setAttribute('referrerpolicy', 'no-referrer');
    this.iframe.setAttribute('allowfullscreen', '');
    this.iframe.setAttribute('title', source.label || 'Видео');
    this.iframe.addEventListener('load', () => {
      this.ready = true;
    });
    this.player.stage.appendChild(this.iframe);
    this.ready = true;
  }
  destroy() {
    this.destroyed = true;
    this.iframe.remove();
  }
}

/* ------------------------------------------------------------------ */
/* Публичный класс                                                     */
/* ------------------------------------------------------------------ */

export class CinemaPlayer {
  constructor(stage, handlers = {}) {
    this.stage = stage;
    this.handlers = handlers;
    this.adapter = null;
    this.source = null;
    this.suppressUntil = 0;
    this.blockHintShown = false;
  }

  emitUser(action) {
    if (Date.now() < this.suppressUntil) return;
    if (!this.handlers.onAction) return;
    this.handlers.onAction(action);
  }

  async load(source) {
    this.destroy();
    this.source = source;
    this.blockHintShown = false;
    if (!source) return;

    this.stage.innerHTML = '';
    const kind = source.kind;

    try {
      if (kind === 'youtube') this.adapter = new YouTubeAdapter(this, source);
      else if (kind === 'vimeo') this.adapter = new VimeoAdapter(this, source);
      else if (kind === 'video' || kind === 'hls' || kind === 'audio') this.adapter = new Html5Adapter(this, source);
      else this.adapter = new IframeAdapter(this, source);
    } catch (error) {
      this.fail('Не удалось создать плеер для этой ссылки.');
      console.warn('[cinema] player:', error);
    }
  }

  fail(message) {
    if (this.handlers.onError) this.handlers.onError(message);
  }

  getTime() {
    return this.adapter ? this.adapter.getTime() : 0;
  }

  getDuration() {
    return this.adapter ? this.adapter.getDuration() : 0;
  }

  isPaused() {
    return this.adapter ? this.adapter.isPaused() : true;
  }

  isReady() {
    return Boolean(this.adapter && this.adapter.ready);
  }

  play() {
    if (!this.adapter) return Promise.resolve();
    this.suppressUntil = Date.now() + 900;
    return (this.adapter.play() || Promise.resolve()).catch(() => {});
  }

  pause() {
    if (!this.adapter) return;
    this.suppressUntil = Date.now() + 900;
    this.adapter.pause();
  }

  seek(time) {
    if (!this.adapter) return;
    this.suppressUntil = Date.now() + 900;
    this.adapter.seek(time);
  }

  toggle() {
    if (!this.adapter) return;
    if (this.isPaused()) this.play();
    else this.pause();
    return this.isPaused();
  }

  /**
   * Приводит локальный плеер к состоянию комнаты.
   * targetTime уже пересчитан с учётом задержки сети.
   */
  applyState(targetTime, playing) {
    if (!this.adapter) return;
    this.suppressUntil = Date.now() + 1100;
    const time = Number.isFinite(targetTime) ? Math.max(0, targetTime) : 0;
    const drift = Math.abs(this.getTime() - time);

    if (playing) {
      if (drift > 1.15) this.adapter.seek(time);
      if (this.isPaused()) {
        this.adapter.play();
        if (!this.blockHintShown) {
          setTimeout(() => {
            if (playing && this.isPaused() && !this.blockHintShown) {
              this.blockHintShown = true;
              this.handlers.onBlocked && this.handlers.onBlocked();
            }
          }, 1400);
        }
      }
    } else {
      if (!this.isPaused()) this.adapter.pause();
      if (drift > 0.7) this.adapter.seek(time);
    }
  }

  destroy() {
    if (this.adapter) {
      try {
        this.adapter.destroy();
      } catch {
        /* ignore */
      }
      this.adapter = null;
    }
    this.stage.innerHTML = '';
  }
}
