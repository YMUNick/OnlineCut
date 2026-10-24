// IndexedDB 儲存：專案 JSON 與素材都只存在使用者自己的瀏覽器裡，不會上傳。
//
// 素材怎麼保存（讓重新整理後還在）：
//   - 小檔案：複製一份到瀏覽器（files）。重新開啟不用再做任何事。
//   - 大檔案：不複製，避免多佔一份硬碟空間、匯入時也不用等。
//       支援 File System Access 的瀏覽器（Chrome / Edge）記住檔案位置（handles），
//       重新開啟時請使用者允許讀取；其他瀏覽器需要重新匯入（同一個檔案會自動接回）。

const DB_NAME = 'onlinecut';
const DB_VERSION = 2;
const FILES = 'files';
const HANDLES = 'handles';
const PROJECTS = 'projects';
const CURRENT = 'current';

export const storageSettings = {
  copyLimitBytes: 100 * 1024 * 1024, // 超過就不複製到瀏覽器
};

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('此瀏覽器不支援 IndexedDB'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
      if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS);
      if (!db.objectStoreNames.contains(HANDLES)) db.createObjectStore(HANDLES);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('資料庫被其他分頁占用，請關閉其他 OnlineCut 分頁後重新整理'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const req = fn(s);
    if (req) req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('儲存被中止（可能是空間不足）'));
  });
}

export const store = {
  saveFile: (id, blob) => tx(FILES, 'readwrite', s => s.put(blob, id)),
  getFile: (id) => tx(FILES, 'readonly', s => s.get(id)),
  deleteFile: (id) => tx(FILES, 'readwrite', s => s.delete(id)),
  listFileIds: () => tx(FILES, 'readonly', s => s.getAllKeys()),
  saveHandle: (id, handle) => tx(HANDLES, 'readwrite', s => s.put(handle, id)),
  getHandle: (id) => tx(HANDLES, 'readonly', s => s.get(id)),
  deleteHandle: (id) => tx(HANDLES, 'readwrite', s => s.delete(id)),
  listHandleIds: () => tx(HANDLES, 'readonly', s => s.getAllKeys()),
  saveProject: (project) => tx(PROJECTS, 'readwrite', s => s.put(project, CURRENT)),
  loadProject: () => tx(PROJECTS, 'readonly', s => s.get(CURRENT)),
  async clearAll() {
    await tx(FILES, 'readwrite', s => s.clear());
    await tx(HANDLES, 'readwrite', s => s.clear());
    await tx(PROJECTS, 'readwrite', s => s.clear());
  },
  /** 估計已用 / 可用空間（bytes），不支援時回傳 null */
  async estimate() {
    try {
      const e = await navigator.storage?.estimate?.();
      return e ? { usage: e.usage, quota: e.quota } : null;
    } catch {
      return null;
    }
  },
  /** 請瀏覽器不要在空間不足時自動清掉這個網站的資料 */
  async persist() {
    try { return await navigator.storage?.persist?.(); } catch { return false; }
  },
};
