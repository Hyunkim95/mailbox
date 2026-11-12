import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppStore } from "../src/app-store.ts";
import { catalogue } from "../src/catalogue.ts";
import { provisionAgentAddress } from "../src/email.ts";

test("agents receive independent connections to the same merchant without inheriting authority", () => {
  const store = new AppStore(
    ":memory:",
    () => new Date(),
    "independent-connection-test-secret-over-32-characters",
  );
  try {
    const a = store.createAgent("owner", {
      name: "Original",
      purpose: "Original account",
    });
    const b = store.createAgent("owner", {
      name: "Shopping",
      purpose: "Fresh account",
    });
    const service = catalogue.services.find((s) => s.id === "basil-market")!;
    const first = store.ensureWallet("owner", service, a.id);
    first.email = "original@example.test";
    first.inbox_id = first.email;
    first.vault_id = "original-private-payment-token";
    first.mode = "auto";
    first.cap = 650;
    store.saveWallet(first);
    const snapshot = JSON.stringify(store.wallet("owner", first.id));
    const second = store.ensureWallet("owner", service, b.id);
    assert.notEqual(second.id, first.id);
    assert.equal(second.agent_id, b.id);
    assert.equal(second.email, null);
    assert.equal(second.vault_id, null);
    assert.equal(second.mode, "draft");
    assert.equal(store.ensureWallet("owner", service, b.id).id, second.id);
    assert.equal(JSON.stringify(store.wallet("owner", first.id)), snapshot);
    assert.throws(
      () => store.ensureWallet("stranger", service, b.id),
      /not available/,
    );
    assert.throws(
      () => store.attachWalletAgent("owner", first.id, b.id),
      /different account address/,
    );
    assert.equal(store.wallets("owner").length, 2);
  } finally {
    store.close();
  }
});

test("legacy wallet migration preserves original rows and remains safe to reopen", () => {
  const folder = mkdtempSync(join(tmpdir(), "mailbox-connections-"));
  const path = join(folder, "app.sqlite");
  const seed = new AppStore(":memory:");
  const service = catalogue.services[0]!;
  const wallet = seed.ensureWallet("owner", service);
  seed.close();
  const body = JSON.stringify(wallet);
  const legacy = new DatabaseSync(path);
  legacy.exec(
    "CREATE TABLE wallets(id TEXT PRIMARY KEY, owner TEXT NOT NULL, service_id TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(owner,service_id))",
  );
  legacy
    .prepare("INSERT INTO wallets VALUES(?,?,?,?)")
    .run(wallet.id, "owner", service.id, body);
  legacy.close();
  try {
    for (let i = 0; i < 2; i++) {
      const store = new AppStore(path);
      try {
        assert.equal(
          store.db
            .prepare("SELECT body FROM wallets WHERE id=?")
            .get(wallet.id)!.body,
          body,
        );
        assert.equal(store.ensureWallet("owner", service).id, wallet.id);
        assert.equal(
          store.db.prepare("PRAGMA integrity_check").get()!.integrity_check,
          "ok",
        );
      } finally {
        store.close();
      }
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("an archived identity cannot acquire a fresh connection or provider inbox", async () => {
  const store = new AppStore(":memory:");
  try {
    const agent = store.createAgent("owner", {
      name: "History",
      purpose: "Retained records",
    });
    agent.archived_at = store.now().toISOString();
    agent.status = "paused";
    store.saveAgent(agent);
    assert.throws(
      () => store.ensureWallet("owner", catalogue.services[0]!, agent.id),
      /archived/,
    );
    await assert.rejects(provisionAgentAddress(store, agent), /archived/);
    assert.equal(store.wallets("owner").length, 0);
  } finally {
    store.close();
  }
});
