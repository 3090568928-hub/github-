// Scoped to the GitHub module's closure on every extension surface.
const githubStoragePrefix = 'github-zh:';

function scopedRecord(record) {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [githubStoragePrefix + key, value]));
}

function originalKeys(record) {
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => key.startsWith(githubStoragePrefix))
    .map(([key, value]) => [key.slice(githubStoragePrefix.length), value]));
}

function scopedArea(area) {
  return {
    async get(keys) {
      let query = keys;
      if (typeof keys === 'string') query = githubStoragePrefix + keys;
      else if (Array.isArray(keys)) query = keys.map(key => githubStoragePrefix + key);
      else if (keys) query = scopedRecord(keys);
      return originalKeys(await area.get(query));
    },
    set(values) {
      return area.set(scopedRecord(values));
    },
    remove(keys) {
      return area.remove([].concat(keys).map(key => githubStoragePrefix + key));
    },
  };
}

const githubStorage = {
  local: scopedArea(chrome.storage.local),
  sync: scopedArea(chrome.storage.sync),
  onChanged: {
    addListener(listener) {
      chrome.storage.onChanged.addListener((changes, area) => {
        const owned = originalKeys(changes);
        if (Object.keys(owned).length) listener(owned, area);
      });
    },
  },
};
