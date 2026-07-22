import fs from "fs";
import path from "path";

// File-based backup databases
const USERS_FILE = path.join(process.cwd(), "db_fallback_users.json");
const PROJECTS_FILE = path.join(process.cwd(), "db_fallback_projects.json");
const PORTFOLIO_FILE = path.join(process.cwd(), "db_fallback_portfolio.json");

// Local cache
let usersDb: Record<string, any> = {};
let projectsDb: Record<string, any> = {};
let portfolioDb: Record<string, any> = {};

// Helper to load JSON safely
function loadJson(filePath: string): Record<string, any> {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, "utf8");
      return JSON.parse(data || "{}");
    }
  } catch (err) {
    console.error(`Failed to load fallback db at ${filePath}:`, err);
  }
  return {};
}

// Helper to save JSON safely
function saveJson(filePath: string, data: any) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error(`Failed to save fallback db at ${filePath}:`, err);
  }
}

// Initialize databases
usersDb = loadJson(USERS_FILE);
projectsDb = loadJson(PROJECTS_FILE);
portfolioDb = loadJson(PORTFOLIO_FILE);

// Check if we should enforce local-only fallback based on past connection errors
let forceLocalFallback = false;

export function setForceLocalFallback(val: boolean) {
  forceLocalFallback = val;
}

export function getForceLocalFallback() {
  return forceLocalFallback;
}

// Class representing a mock/fallback DocumentSnapshot
class FallbackDocumentSnapshot {
  constructor(public id: string, public exists: boolean, private _data: any) {}
  data() {
    return this._data ? JSON.parse(JSON.stringify(this._data)) : undefined;
  }
}

// Class representing a mock/fallback QuerySnapshot
class FallbackQuerySnapshot {
  public docs: FallbackDocumentSnapshot[] = [];
  public empty = true;
  public size = 0;

  constructor(docs: FallbackDocumentSnapshot[]) {
    this.docs = docs;
    this.empty = docs.length === 0;
    this.size = docs.length;
  }
}

// Core Hybrid Firestore Wrapper
export class HybridFirestore {
  constructor(private realDb: any) {}

  collection(collectionName: string) {
    return new HybridCollectionReference(this.realDb, collectionName);
  }
}

class HybridCollectionReference {
  private filters: Array<{ field: string; op: string; val: any }> = [];
  private orderField: string | null = null;
  private orderDirection: "asc" | "desc" = "asc";
  private limitCount: number | null = null;

  constructor(private realDb: any, private collectionName: string) {}

  doc(docId: string) {
    return new HybridDocumentReference(this.realDb, this.collectionName, docId);
  }

  where(field: string, op: string, val: any) {
    const ref = new HybridCollectionReference(this.realDb, this.collectionName);
    ref.filters = [...this.filters, { field, op, val }];
    ref.orderField = this.orderField;
    ref.orderDirection = this.orderDirection;
    ref.limitCount = this.limitCount;
    return ref;
  }

  orderBy(field: string, direction: "asc" | "desc" = "asc") {
    const ref = new HybridCollectionReference(this.realDb, this.collectionName);
    ref.filters = this.filters;
    ref.orderField = field;
    ref.orderDirection = direction;
    ref.limitCount = this.limitCount;
    return ref;
  }

  limit(n: number) {
    const ref = new HybridCollectionReference(this.realDb, this.collectionName);
    ref.filters = this.filters;
    ref.orderField = this.orderField;
    ref.orderDirection = this.orderDirection;
    ref.limitCount = n;
    return ref;
  }

  async get() {
    if (!forceLocalFallback && this.realDb) {
      try {
        let realQuery = this.realDb.collection(this.collectionName);
        for (const f of this.filters) {
          realQuery = realQuery.where(f.field, f.op, f.val);
        }
        if (this.orderField) {
          realQuery = realQuery.orderBy(this.orderField, this.orderDirection);
        }
        if (this.limitCount !== null) {
          realQuery = realQuery.limit(this.limitCount);
        }
        const snap = await realQuery.get();
        return snap;
      } catch (err: any) {
        if (err?.message?.includes("PERMISSION_DENIED") || err?.code === 7) {
          console.warn(`[HybridDB] PERMISSION_DENIED on collection get (${this.collectionName}), switching to local fallback`);
          forceLocalFallback = true;
        } else {
          console.error(`[HybridDB] Error fetching collection (${this.collectionName}) from real Firestore:`, err);
        }
      }
    }

    // Local Fallback Reading
    let dataMap: Record<string, any> = {};
    if (this.collectionName === "users") dataMap = usersDb;
    else if (this.collectionName === "projects") dataMap = projectsDb;
    else if (this.collectionName === "portfolio") dataMap = portfolioDb;

    let items = Object.entries(dataMap).map(([id, data]) => ({ id, data }));

    // Apply where filters (simplistic support for ==)
    for (const filter of this.filters) {
      if (filter.op === "==") {
        items = items.filter((item) => item.data && item.data[filter.field] === filter.val);
      }
    }

    // Apply ordering
    if (this.orderField) {
      const field = this.orderField;
      const dir = this.orderDirection === "desc" ? -1 : 1;
      items.sort((a, b) => {
        const valA = a.data ? a.data[field] : undefined;
        const valB = b.data ? b.data[field] : undefined;
        if (valA === undefined) return 1 * dir;
        if (valB === undefined) return -1 * dir;
        if (valA < valB) return -1 * dir;
        if (valA > valB) return 1 * dir;
        return 0;
      });
    }

    // Apply limit
    if (this.limitCount !== null) {
      items = items.slice(0, this.limitCount);
    }

    const docs = items.map((item) => new FallbackDocumentSnapshot(item.id, true, item.data));
    return new FallbackQuerySnapshot(docs);
  }
}

class HybridDocumentReference {
  constructor(private realDb: any, private collectionName: string, private docId: string) {}

  async get() {
    if (!forceLocalFallback && this.realDb) {
      try {
        const snap = await this.realDb.collection(this.collectionName).doc(this.docId).get();
        return snap;
      } catch (err: any) {
        if (err?.message?.includes("PERMISSION_DENIED") || err?.code === 7) {
          console.warn(`[HybridDB] PERMISSION_DENIED on document get (${this.collectionName}/${this.docId}), switching to local fallback`);
          forceLocalFallback = true;
        } else {
          console.error(`[HybridDB] Error fetching doc (${this.collectionName}/${this.docId}) from real Firestore:`, err);
        }
      }
    }

    // Local Fallback Reading
    let dataMap: Record<string, any> = {};
    if (this.collectionName === "users") dataMap = usersDb;
    else if (this.collectionName === "projects") dataMap = projectsDb;
    else if (this.collectionName === "portfolio") dataMap = portfolioDb;

    const data = dataMap[this.docId];
    return new FallbackDocumentSnapshot(this.docId, data !== undefined, data);
  }

  async set(data: any, options?: any) {
    let localSuccess = false;
    
    // Save locally first
    let dataMap: Record<string, any> = {};
    let dbFile = "";
    if (this.collectionName === "users") {
      dataMap = usersDb;
      dbFile = USERS_FILE;
    } else if (this.collectionName === "projects") {
      dataMap = projectsDb;
      dbFile = PROJECTS_FILE;
    } else if (this.collectionName === "portfolio") {
      dataMap = portfolioDb;
      dbFile = PORTFOLIO_FILE;
    }

    if (dbFile) {
      if (options?.merge && dataMap[this.docId]) {
        dataMap[this.docId] = { ...dataMap[this.docId], ...data };
      } else {
        dataMap[this.docId] = data;
      }
      saveJson(dbFile, dataMap);
      localSuccess = true;
    }

    if (!forceLocalFallback && this.realDb) {
      try {
        await this.realDb.collection(this.collectionName).doc(this.docId).set(data, options);
      } catch (err: any) {
        if (err?.message?.includes("PERMISSION_DENIED") || err?.code === 7) {
          console.warn(`[HybridDB] PERMISSION_DENIED on document set (${this.collectionName}/${this.docId}), switching to local fallback`);
          forceLocalFallback = true;
        } else {
          console.error(`[HybridDB] Error setting doc (${this.collectionName}/${this.docId}) on real Firestore:`, err);
        }
      }
    }

    return localSuccess;
  }

  async update(data: any) {
    let localSuccess = false;

    // Update locally first
    let dataMap: Record<string, any> = {};
    let dbFile = "";
    if (this.collectionName === "users") {
      dataMap = usersDb;
      dbFile = USERS_FILE;
    } else if (this.collectionName === "projects") {
      dataMap = projectsDb;
      dbFile = PROJECTS_FILE;
    } else if (this.collectionName === "portfolio") {
      dataMap = portfolioDb;
      dbFile = PORTFOLIO_FILE;
    }

    if (dbFile && dataMap[this.docId]) {
      dataMap[this.docId] = { ...dataMap[this.docId], ...data };
      saveJson(dbFile, dataMap);
      localSuccess = true;
    }

    if (!forceLocalFallback && this.realDb) {
      try {
        await this.realDb.collection(this.collectionName).doc(this.docId).update(data);
      } catch (err: any) {
        if (err?.message?.includes("PERMISSION_DENIED") || err?.code === 7) {
          console.warn(`[HybridDB] PERMISSION_DENIED on document update (${this.collectionName}/${this.docId}), switching to local fallback`);
          forceLocalFallback = true;
        } else {
          console.error(`[HybridDB] Error updating doc (${this.collectionName}/${this.docId}) on real Firestore:`, err);
        }
      }
    }

    return localSuccess;
  }

  async delete() {
    let localSuccess = false;

    // Delete locally first
    let dataMap: Record<string, any> = {};
    let dbFile = "";
    if (this.collectionName === "users") {
      dataMap = usersDb;
      dbFile = USERS_FILE;
    } else if (this.collectionName === "projects") {
      dataMap = projectsDb;
      dbFile = PROJECTS_FILE;
    } else if (this.collectionName === "portfolio") {
      dataMap = portfolioDb;
      dbFile = PORTFOLIO_FILE;
    }

    if (dbFile && dataMap[this.docId]) {
      delete dataMap[this.docId];
      saveJson(dbFile, dataMap);
      localSuccess = true;
    }

    if (!forceLocalFallback && this.realDb) {
      try {
        await this.realDb.collection(this.collectionName).doc(this.docId).delete();
      } catch (err: any) {
        if (err?.message?.includes("PERMISSION_DENIED") || err?.code === 7) {
          console.warn(`[HybridDB] PERMISSION_DENIED on document delete (${this.collectionName}/${this.docId}), switching to local fallback`);
          forceLocalFallback = true;
        } else {
          console.error(`[HybridDB] Error deleting doc (${this.collectionName}/${this.docId}) on real Firestore:`, err);
        }
      }
    }

    return localSuccess;
  }
}
