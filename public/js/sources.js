/* Разбор ссылок: определяем платформу и готовим параметры для плеера. */

export const PLATFORMS = {
  youtube: { label: 'YouTube', syncable: true },
  vimeo: { label: 'Vimeo', syncable: true },
  rutube: { label: 'Rutube', syncable: false },
  vk: { label: 'VK Видео', syncable: false },
  ok: { label: 'OK.RU', syncable: false },
  dailymotion: { label: 'Dailymotion', syncable: false },
  twitch: { label: 'Twitch', syncable: false },
  video: { label: 'Видеофайл', syncable: true },
  hls: { label: 'HLS-поток', syncable: true },
  audio: { label: 'Аудио', syncable: true },
  iframe: { label: 'Внешняя страница', syncable: false },
};

const MEDIA_EXT = /\.(mp4|webm|ogv|ogg|m4v|mov)(\?|#|$)/i;
const HLS_EXT = /\.m3u8(\?|#|$)/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|opus|oga)(\?|#|$)/i;

function normalizeInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function ytId(url, pathname) {
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (host === 'youtu.be') {
    const id = pathname.split('/').filter(Boolean)[0];
    return id && /^[\w-]{6,}$/.test(id) ? id : '';
  }
  const v = url.searchParams.get('v');
  if (v && /^[\w-]{6,}$/.test(v)) return v;
  const match = pathname.match(/\/(?:embed|shorts|live|v)\/([\w-]{6,})/);
  return match ? match[1] : '';
}

/**
 * Возвращает описание источника или null, если строку нельзя использовать.
 */
export function parseSource(input) {
  const raw = normalizeInput(input);
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  const path = url.pathname;

  /* ---------- YouTube ---------- */
  if (host === 'youtu.be' || host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
    const id = ytId(url, path);
    if (id) {
      return {
        kind: 'youtube',
        ...PLATFORMS.youtube,
        id,
        url: `https://www.youtube.com/watch?v=${id}`,
        embedUrl: `https://www.youtube.com/embed/${id}?enablejsapi=1&playsinline=1&rel=0&modestbranding=1`,
        thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      };
    }
  }

  /* ---------- Vimeo ---------- */
  if (host.endsWith('vimeo.com')) {
    const match = path.match(/(\d{6,})/);
    if (match) {
      const id = match[1];
      const hash = path.split('/').filter(Boolean)[1];
      const h = hash && /^[0-9a-f]{6,}$/i.test(hash) ? `&h=${hash}` : '';
      return {
        kind: 'vimeo',
        ...PLATFORMS.vimeo,
        id,
        url: `https://vimeo.com/${id}`,
        embedUrl: `https://player.vimeo.com/video/${id}?autoplay=0&title=0&byline=0&portrait=0${h}`,
      };
    }
  }

  /* ---------- Rutube ---------- */
  if (host.endsWith('rutube.ru')) {
    const match = path.match(/\/(?:video|play\/embed)\/([0-9a-f]{32})/i);
    if (match) {
      return {
        kind: 'rutube',
        ...PLATFORMS.rutube,
        id: match[1],
        url: `https://rutube.ru/video/${match[1]}/`,
        embedUrl: `https://rutube.ru/play/embed/${match[1]}/`,
      };
    }
  }

  /* ---------- VK Видео ---------- */
  if (host.endsWith('vk.com') || host.endsWith('vkvideo.ru') || host.endsWith('vk.ru')) {
    const match = path.match(/video(-?\d+)_(\d+)/);
    if (match) {
      const oid = match[1];
      const id = match[2];
      return {
        kind: 'vk',
        ...PLATFORMS.vk,
        id: `${oid}_${id}`,
        url: `https://vk.com/video${oid}_${id}`,
        embedUrl: `https://vk.com/video_ext.php?oid=${oid}&id=${id}&hd=2`,
      };
    }
  }

  /* ---------- OK.RU ---------- */
  if (host.endsWith('ok.ru') || host.endsWith('odnoklassniki.ru')) {
    const match = path.match(/\/video(?:embed)?\/(\d+)/);
    if (match) {
      return {
        kind: 'ok',
        ...PLATFORMS.ok,
        id: match[1],
        url: `https://ok.ru/video/${match[1]}`,
        embedUrl: `https://ok.ru/videoembed/${match[1]}`,
      };
    }
  }

  /* ---------- Dailymotion ---------- */
  if (host === 'dai.ly' || host.endsWith('dailymotion.com')) {
    const match = path.match(/\/(?:video|embed\/video)\/([a-z0-9]{5,})/i) || path.match(/^\/([a-z0-9]{5,})$/i);
    if (match) {
      return {
        kind: 'dailymotion',
        ...PLATFORMS.dailymotion,
        id: match[1],
        url: `https://www.dailymotion.com/video/${match[1]}`,
        embedUrl: `https://www.dailymotion.com/embed/video/${match[1]}`,
      };
    }
  }

  /* ---------- Twitch ---------- */
  if (host.endsWith('twitch.tv')) {
    const vod = path.match(/\/videos\/(\d+)/);
    const parent = typeof location !== 'undefined' ? location.hostname : 'localhost';
    if (vod) {
      return {
        kind: 'twitch',
        ...PLATFORMS.twitch,
        id: vod[1],
        url: `https://www.twitch.tv/videos/${vod[1]}`,
        embedUrl: `https://player.twitch.tv/?video=${vod[1]}&parent=${encodeURIComponent(parent)}&autoplay=false`,
      };
    }
    const channel = path.match(/^\/([a-zA-Z0-9_]{3,})/);
    if (channel && !['directory', 'videos', 'settings'].includes(channel[1].toLowerCase())) {
      return {
        kind: 'twitch',
        ...PLATFORMS.twitch,
        id: channel[1],
        url: `https://www.twitch.tv/${channel[1]}`,
        embedUrl: `https://player.twitch.tv/?channel=${encodeURIComponent(channel[1])}&parent=${encodeURIComponent(parent)}&autoplay=false`,
      };
    }
  }

  /* ---------- Прямые медиа ---------- */
  const cleanPath = `${path}${url.search}`;
  if (HLS_EXT.test(cleanPath)) {
    return { kind: 'hls', ...PLATFORMS.hls, url: url.href, embedUrl: url.href };
  }
  if (MEDIA_EXT.test(cleanPath)) {
    return { kind: 'video', ...PLATFORMS.video, url: url.href, embedUrl: url.href };
  }
  if (AUDIO_EXT.test(cleanPath)) {
    return { kind: 'audio', ...PLATFORMS.audio, url: url.href, embedUrl: url.href };
  }

  /* ---------- Всё остальное — iframe ---------- */
  return {
    kind: 'iframe',
    ...PLATFORMS.iframe,
    url: url.href,
    embedUrl: url.href,
  };
}

export function describeSource(source) {
  if (!source) return 'Видео не выбрано';
  const platform = PLATFORMS[source.kind] || PLATFORMS.iframe;
  return platform.label;
}

/** Метаданные через oEmbed (необязательный бонус, всё работает и без него). */
export async function fetchMeta(source, { timeout = 4000 } = {}) {
  if (!source) return null;
  const endpoints = {
    youtube: `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${source.id}`)}&format=json`,
    vimeo: `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${source.id}`)}`,
    rutube: `https://rutube.ru/api/oembed/?url=${encodeURIComponent(`https://rutube.ru/video/${source.id}/`)}&format=json`,
    dailymotion: `https://www.dailymotion.com/services/oembed?url=${encodeURIComponent(`https://www.dailymotion.com/video/${source.id}`)}&format=json`,
  };
  const endpoint = endpoints[source.kind];
  if (!endpoint) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(endpoint, { signal: controller.signal, mode: 'cors' });
    if (!response.ok) throw new Error('oembed');
    const data = await response.json();
    return {
      title: typeof data.title === 'string' ? data.title : '',
      author: typeof data.author_name === 'string' ? data.author_name : '',
      thumbnail: typeof data.thumbnail_url === 'string' ? data.thumbnail_url : '',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
