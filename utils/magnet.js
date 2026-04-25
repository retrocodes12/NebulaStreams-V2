const VIDEO_EXTENSIONS = new Set([
  '.mkv',
  '.mp4',
  '.avi',
  '.mov',
  '.wmv',
  '.flv',
  '.webm',
  '.m4v',
  '.mpg',
  '.mpeg',
  '.ts'
]);

export const RELIABLE_TRACKERS = Object.freeze([
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce'
]);

const normalizeTracker = (tracker) => {
  const normalized = String(tracker || '').trim();

  if (!normalized) {
    return null;
  }

  try {
    const parsedUrl = new URL(normalized);

    if (!['udp:', 'http:', 'https:'].includes(parsedUrl.protocol)) {
      return null;
    }

    return parsedUrl.toString();
  } catch {
    return null;
  }
};

export const validateMagnet = (magnet) => {
  if (typeof magnet !== 'string' || !magnet.trim()) {
    return {
      valid: false,
      error: 'Magnet link must be a non-empty string'
    };
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(magnet.trim());
  } catch {
    return {
      valid: false,
      error: 'Magnet link format is invalid'
    };
  }

  if (parsedUrl.protocol !== 'magnet:') {
    return {
      valid: false,
      error: 'URL must use the magnet protocol'
    };
  }

  const xtValues = parsedUrl.searchParams.getAll('xt');
  const infoHashValue = xtValues.find((value) => {
    const match = /^urn:btih:([a-z0-9]+)$/iu.exec(value);

    if (!match?.[1]) {
      return false;
    }

    const infoHash = match[1];
    const isHexInfoHash = /^[a-f0-9]{40}$/iu.test(infoHash);
    const isBase32InfoHash = /^[a-z2-7]{32}$/iu.test(infoHash);

    return isHexInfoHash || isBase32InfoHash;
  });

  if (!infoHashValue) {
    return {
      valid: false,
      error: 'Magnet link must contain a valid btih xt parameter'
    };
  }

  return {
    valid: true,
    parsedUrl,
    infoHash: infoHashValue.slice('urn:btih:'.length).toLowerCase()
  };
};

export const enhanceMagnet = (magnet) => {
  const validation = validateMagnet(magnet);

  if (!validation.valid) {
    throw new TypeError(validation.error);
  }

  const { parsedUrl } = validation;
  const existingTrackers = parsedUrl.searchParams.getAll('tr');
  const uniqueTrackers = new Set();
  const orderedTrackers = [];

  for (const tracker of [...existingTrackers, ...RELIABLE_TRACKERS]) {
    const normalizedTracker = normalizeTracker(tracker);

    if (!normalizedTracker) {
      continue;
    }

    const dedupeKey = normalizedTracker.toLowerCase();

    if (uniqueTrackers.has(dedupeKey)) {
      continue;
    }

    uniqueTrackers.add(dedupeKey);
    orderedTrackers.push(normalizedTracker);
  }

  parsedUrl.searchParams.delete('tr');

  for (const tracker of orderedTrackers) {
    parsedUrl.searchParams.append('tr', tracker);
  }

  const queryEntries = [];

  for (const [key, value] of parsedUrl.searchParams.entries()) {
    if (key === 'xt') {
      queryEntries.push(`xt=${value}`);
      continue;
    }

    queryEntries.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }

  return `magnet:?${queryEntries.join('&')}`;
};

export const extractInfoHash = (magnetUri) => {
  const validation = validateMagnet(magnetUri);

  if (!validation.valid) {
    return null;
  }

  return validation.infoHash;
};

export const isVideoFile = (fileName) => {
  const normalized = String(fileName || '').toLowerCase();

  for (const extension of VIDEO_EXTENSIONS) {
    if (normalized.endsWith(extension)) {
      return true;
    }
  }

  return false;
};

export const resolveRequestedFile = (files, { fileIndex, fileName } = {}) => {
  if (!Array.isArray(files) || files.length === 0) {
    return null;
  }

  if (Number.isInteger(fileIndex) && fileIndex >= 0 && fileIndex < files.length) {
    return files[fileIndex];
  }

  if (typeof fileName === 'string' && fileName.trim()) {
    const normalizedNeedle = fileName.trim().toLowerCase();

    const exactMatch = files.find((file) => file.name.toLowerCase() === normalizedNeedle);

    if (exactMatch) {
      return exactMatch;
    }

    const partialMatch = files.find((file) => file.name.toLowerCase().includes(normalizedNeedle));

    if (partialMatch) {
      return partialMatch;
    }
  }

  const preferredVideo = files
    .filter((file) => isVideoFile(file.name))
    .sort((left, right) => right.length - left.length)[0];

  if (preferredVideo) {
    return preferredVideo;
  }

  return files.slice().sort((left, right) => right.length - left.length)[0];
};
