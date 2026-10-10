const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");

const dataDir = path.join(__dirname, "..", "data");
if (!fs.existsSync(dataDir)) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (e) {
    // ignore
  }
}

const isPureMemory = process.env.CACHE_STORAGE === "memory" || process.env.VERCEL;
const dbPath = isPureMemory ? ":memory:" : path.join(dataDir, "ticketing.db");

let sqlite;
try {
  sqlite = new Database(dbPath);
  if (!isPureMemory) {
    sqlite.pragma("journal_mode = WAL");
  }
  sqlite.pragma("foreign_keys = ON");
} catch (e) {
  console.warn("Falling back to pure in-memory cache database:", e.message);
  sqlite = new Database(":memory:");
}

// Custom functions
sqlite.function("regexp_replace", (str, pattern, replacement) => {
  if (typeof str !== "string") return "";
  try {
    return str.replace(new RegExp(pattern), replacement);
  } catch (e) {
    return str;
  }
});

function translateSql(sql) {
  return sql
    .replace(/\$\d+/g, "?")
    .replace(/\bcreated_at::date\b/gi, "substr(created_at, 1, 10)")
    .replace(/EXTRACT\s*\(\s*EPOCH\s+FROM\s+NOW\(\)\s*\)/gi, "CAST(strftime('%s', 'now') AS REAL)")
    .replace(/EXTRACT\s*\(\s*EPOCH\s+FROM\s+([a-zA-Z0-9_]+)\s*\)/gi, "CAST(strftime('%s', $1) AS REAL)")
    .replace(/\bNOW\(\)/gi, "datetime('now')");
}

const stmtCache = new Map();

function getPreparedStatement(sql) {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    const translated = translateSql(sql);
    stmt = sqlite.prepare(translated);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

const db = {
  prepare(sql) {
    const stmt = getPreparedStatement(sql);
    return {
      async run(...params) {
        try {
          const result = stmt.run(...params);
          return { lastInsertRowid: result.lastInsertRowid, changes: result.changes };
        } catch (err) {
          console.error("Cache DB run error:", err.message, "SQL:", sql);
          throw err;
        }
      },
      async get(...params) {
        try {
          const result = stmt.get(...params);
          return result !== undefined ? result : null;
        } catch (err) {
          console.error("Cache DB get error:", err.message, "SQL:", sql);
          throw err;
        }
      },
      async all(...params) {
        try {
          return stmt.all(...params);
        } catch (err) {
          console.error("Cache DB all error:", err.message, "SQL:", sql);
          throw err;
        }
      },
    };
  },

  async exec(sql) {
    sqlite.exec(sql);
  },

  async query(sql, params = []) {
    const stmt = getPreparedStatement(sql);
    return stmt.all(...params);
  },

  transaction(fn) {
    return async function (...args) {
      sqlite.exec("BEGIN");
      try {
        const result = await fn(...args);
        sqlite.exec("COMMIT");
        return result;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    };
  },

  getPool() {
    return sqlite;
  },
};

let initDone = false;

async function initializeDatabase() {
  if (initDone) return;

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expire TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT,
      brand_color TEXT,
      logo_url TEXT,
      invite_required INTEGER NOT NULL DEFAULT 0,
      allowed_domains TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      plan TEXT NOT NULL DEFAULT 'starter',
      trial_ends_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      company_id INTEGER NOT NULL DEFAULT 1,
      user_id INTEGER,
      assignee_id INTEGER,
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'medium',
      priority_confidence REAL,
      priority_reason TEXT,
      sla_due_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      company_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER,
      company_id INTEGER,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      details TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payment_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      owner_id INTEGER NOT NULL,
      method TEXT NOT NULL,
      reference TEXT,
      amount TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      paid_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      email TEXT,
      role TEXT NOT NULL DEFAULT 'requester',
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      price_usd INTEGER NOT NULL,
      price_php INTEGER NOT NULL,
      icon TEXT
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      company_id INTEGER,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_tickets_company_id ON tickets(company_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_user_id ON tickets(user_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_assignee_id ON tickets(assignee_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_users_company_id ON users(company_id);
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
    CREATE INDEX IF NOT EXISTS idx_credentials_email ON credentials(email);
    CREATE INDEX IF NOT EXISTS idx_credentials_user_id ON credentials(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);
    CREATE INDEX IF NOT EXISTS idx_companies_slug ON companies(slug);
  `);

  // Seed plans
  const planCount = sqlite.prepare("SELECT COUNT(*) as count FROM plans").get().count;
  if (planCount === 0) {
    const insertPlan = sqlite.prepare(
      "INSERT INTO plans (code, name, price_usd, price_php, icon) VALUES (?, ?, ?, ?, ?)"
    );
    insertPlan.run("starter", "Starter", 29, 1499, "🌱");
    insertPlan.run("growth", "Growth", 99, 4999, "🚀");
    insertPlan.run("enterprise", "Enterprise", 299, 14999, "🏢");
  }

  // Seed default company
  const companyCount = sqlite.prepare("SELECT COUNT(*) as count FROM companies").get().count;
  if (companyCount === 0) {
    sqlite.prepare(
      "INSERT INTO companies (name, slug, status, plan, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run("Acme", "acme", "active", "starter");
  }

  sqlite.prepare(
    "UPDATE companies SET slug = LOWER(REPLACE(name, ' ', '-')) WHERE slug IS NULL"
  ).run();

  const firstCompany = sqlite.prepare("SELECT id FROM companies ORDER BY id LIMIT 1").get();
  const companyId = firstCompany ? firstCompany.id : 1;

  // Seed users
  const userCount = sqlite.prepare("SELECT COUNT(*) as count FROM users").get().count;
  if (userCount === 0) {
    const insertUser = sqlite.prepare("INSERT INTO users (name, role, company_id) VALUES (?, ?, ?)");
    insertUser.run("Avery Kim", "requester", companyId);
    insertUser.run("Jordan Lee", "requester", companyId);
    insertUser.run("Riley Patel", "requester", companyId);
    insertUser.run("Morgan Diaz", "agent", companyId);
    insertUser.run("Casey Ortiz", "agent", companyId);
  }

  // Seed credentials (password: password123)
  const passwordHash = "$2b$10$h.YgIhwB0gSorPVnPew/Y.v83W/te35AYkvyM0xWbMG03iiOD4u5m";
  const credCount = sqlite.prepare("SELECT COUNT(*) as count FROM credentials").get().count;
  if (credCount === 0) {
    const users = sqlite.prepare("SELECT id, name FROM users").all();
    const insertCred = sqlite.prepare("INSERT INTO credentials (user_id, email, password_hash) VALUES (?, ?, ?)");
    for (const u of users) {
      const email = `${u.name.toLowerCase().replace(/\s+/g, ".")}@acme.test`;
      insertCred.run(u.id, email, passwordHash);
    }
  }

  // Seed platform admin
  const superAdmin = sqlite.prepare("SELECT id FROM users WHERE role = 'super_admin' LIMIT 1").get();
  if (!superAdmin) {
    sqlite.prepare("DELETE FROM credentials WHERE email = ?").run("admin@platform.test");
    const result = sqlite.prepare("INSERT INTO users (name, role, company_id) VALUES (?, ?, NULL)").run("Platform Admin", "super_admin");
    sqlite.prepare("INSERT INTO credentials (user_id, email, password_hash) VALUES (?, ?, ?)").run(result.lastInsertRowid, "admin@platform.test", passwordHash);
  }

  // Seed sample tickets if empty
  const ticketCount = sqlite.prepare("SELECT COUNT(*) as count FROM tickets").get().count;
  if (ticketCount === 0) {
    const agent = sqlite.prepare("SELECT id FROM users WHERE role = 'agent' AND company_id = ? LIMIT 1").get(companyId);
    const requester = sqlite.prepare("SELECT id FROM users WHERE role = 'requester' AND company_id = ? LIMIT 1").get(companyId);
    const agentId = agent ? agent.id : null;
    const reqId = requester ? requester.id : 1;

    const insertTicket = sqlite.prepare(`
      INSERT INTO tickets (title, description, company_id, user_id, assignee_id, status, priority, priority_confidence, priority_reason, created_at, sla_due_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now', '+2 days'))
    `);

    insertTicket.run("Cannot connect to corporate VPN", "Unable to establish connection after router reboot. Getting timeout error.", companyId, reqId, agentId, "open", "high", 0.95, "Urgent remote work blocker");
    insertTicket.run("Second monitor flickering over HDMI", "Display flashes black every 10 seconds. Tried switching cable.", companyId, reqId, agentId, "in_progress", "medium", 0.85, "Hardware display issue");
    insertTicket.run("Password reset for finance dashboard", "Need reset link for monthly reports portal.", companyId, reqId, agentId, "resolved", "low", 0.99, "Account access request");
  }

  initDone = true;
  console.log(`Cache storage initialized successfully (${isPureMemory ? "pure memory" : dbPath}).`);
}

module.exports = { db, pool: sqlite, initializeDatabase };
