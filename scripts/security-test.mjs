import { createClient } from "@supabase/supabase-js";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const names = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_TEST_USER_A_EMAIL",
  "SUPABASE_TEST_USER_A_PASSWORD",
  "SUPABASE_TEST_USER_B_EMAIL",
  "SUPABASE_TEST_USER_B_PASSWORD",
];
if (names.some((key) => !process.env[key])) {
  console.error(
    "NOT RUN: 전용 Supabase 프로젝트와 테스트 계정 2개가 필요합니다. docs/SETUP.md를 확인하세요.",
  );
  process.exit(2);
}
const url = process.env[names[0]],
  key = process.env[names[1]];
const client = () =>
  createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
const a = client(),
  b = client(),
  anon = client();
const login = async (c, email, password) => {
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  assert.ifError(error);
  return data.user.id;
};
const aId = await login(a, process.env[names[2]], process.env[names[3]]),
  bId = await login(b, process.env[names[4]], process.env[names[5]]);
assert.notEqual(aId, bId, "테스트 계정은 서로 달라야 합니다.");
const ideaId = crypto.randomUUID(),
  imageId = crypto.randomUUID(),
  linkId = crypto.randomUUID(),
  tagName = `security-${ideaId}`,
  path = `${aId}/${ideaId}/${imageId}`;
let tagId;
const doc = {
  id: ideaId,
  user_id: aId,
  title: "RLS security fixture",
  content: { type: "doc", content: [] },
  plain_text: "",
  is_completed: false,
  is_pinned: false,
  deleted_at: null,
  tags: [tagName],
  links: [
    {
      id: linkId,
      type: "website",
      label: "Safe link",
      url: "https://example.com",
    },
  ],
  images: [{ id: imageId, storage_path: path, original_filename: "test.png" }],
};
const empty = async (p, label) => {
  const result = await p;
  assert.ifError(result.error);
  assert.equal(result.data.length, 0, label);
};
try {
  const saved = await a.rpc("save_idea", {
    document: doc,
    expected_version: 0,
  });
  assert.ifError(saved.error);
  assert.equal(saved.data.version, 1);
  const tags = await a.from("tags").select("id").eq("name", tagName).single();
  assert.ifError(tags.error);
  tagId = tags.data.id;
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  assert.ifError(
    (
      await a.storage
        .from("idea-images")
        .upload(path, png, { contentType: "image/png" })
    ).error,
  );
  const fixtures = [
    ["ideas", "id", ideaId],
    ["tags", "id", tagId],
    ["idea_tags", "idea_id", ideaId],
    ["idea_links", "id", linkId],
    ["idea_images", "id", imageId],
  ];
  for (const [table, column, value] of fixtures) {
    await empty(
      b.from(table).select("*").eq(column, value),
      `${table}: B cannot read A`,
    );
    await empty(
      b.from(table).delete().eq(column, value).select(),
      `${table}: B cannot delete A`,
    );
    const result = await anon.from(table).select("*").eq(column, value);
    assert.ok(
      result.error || result.data.length === 0,
      `${table}: anonymous access must fail`,
    );
  }
  const denied = await b.from("idea_links").insert({
    id: crypto.randomUUID(),
    idea_id: ideaId,
    type: "website",
    label: "attack",
    url: "https://example.com",
  });
  assert.ok(denied.error, "B cannot attach link to A");
  const denyImage = await b.from("idea_images").insert({
    id: crypto.randomUUID(),
    idea_id: ideaId,
    storage_path: `${bId}/${ideaId}/attack`,
    original_filename: "attack.png",
  });
  assert.ok(denyImage.error, "B cannot attach image to A");
  await empty(
    b
      .from("ideas")
      .update({ title: "intrusion", version: 2 })
      .eq("id", ideaId)
      .select(),
    "B cannot update A",
  );
  await empty(
    b.from("tags").update({ name: "intrusion" }).eq("id", tagId).select(),
    "B cannot update A tags",
  );
  await empty(
    b
      .from("idea_links")
      .update({ label: "intrusion" })
      .eq("id", linkId)
      .select(),
    "B cannot update A links",
  );
  await empty(
    b
      .from("idea_images")
      .update({ original_filename: "intrusion" })
      .eq("id", imageId)
      .select(),
    "B cannot update A images",
  );
  const crossTag = await b
    .from("idea_tags")
    .insert({ idea_id: ideaId, tag_id: tagId });
  assert.ok(crossTag.error, "B cannot link A tags");
  const claimed = await b.rpc("save_idea", {
    document: doc,
    expected_version: 1,
  });
  assert.ok(claimed.error, "B cannot impersonate A");
  const storageRead = await b.storage
    .from("idea-images")
    .createSignedUrl(path, 60);
  assert.ok(storageRead.error, "B cannot sign A image");
  const storageAnon = await anon.storage.from("idea-images").download(path);
  assert.ok(storageAnon.error, "Anonymous cannot download A image");
  const uploadAttack = await b.storage
    .from("idea-images")
    .upload(`${aId}/${ideaId}/attack`, png, { contentType: "image/png" });
  assert.ok(uploadAttack.error, "B cannot upload into A folder");
  const removeAttack = await b.storage.from("idea-images").remove([path]);
  assert.ok(
    removeAttack.error || removeAttack.data.length === 0,
    "B cannot delete A image",
  );
  assert.ifError((await a.storage.from("idea-images").download(path)).error);
  const changed = await a.rpc("save_idea", {
    document: { ...doc, title: "server version" },
    expected_version: 1,
  });
  assert.ifError(changed.error);
  assert.equal(changed.data.version, 2);
  const stale = await a.rpc("save_idea", {
    document: { ...doc, title: "stale overwrite" },
    expected_version: 1,
  });
  assert.match(stale.error?.message || "", /VERSION_CONFLICT/);
  const invalid = await a.rpc("save_idea", {
    document: {
      ...doc,
      title: "must roll back",
      links: [
        {
          id: linkId,
          type: "website",
          label: "bad",
          url: "javascript:alert(1)",
        },
      ],
    },
    expected_version: 2,
  });
  assert.ok(invalid.error, "Unsafe URL rejected");
  const after = await a
    .from("ideas")
    .select("title,version")
    .eq("id", ideaId)
    .single();
  assert.deepEqual(
    after.data,
    { title: "server version", version: 2 },
    "Failed child write rolls back entire save",
  );
  assert.ok((await anon.rpc("list_ideas")).error, "Anonymous cannot list RPC");
  console.log(
    "PASS: all five tables, identity, Storage isolation, compare-and-swap, unsafe URLs and transaction rollback.",
  );
} finally {
  // Only this invocation’s random fixture IDs are removed.
  await a.storage.from("idea-images").remove([path]);
  await a.from("ideas").delete().eq("id", ideaId);
  if (tagId) await a.from("tags").delete().eq("id", tagId);
  await a.auth.signOut();
  await b.auth.signOut();
}
