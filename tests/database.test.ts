import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { makeIdea } from "../src/lib/model";
let db: PGlite;
const alice = "11111111-1111-4111-8111-111111111111",
  bob = "22222222-2222-4222-8222-222222222222";
const idea = {
  ...makeIdea("Database fixture", alice),
  tags: ["db-test"],
  links: [
    {
      id: crypto.randomUUID(),
      label: "Example",
      type: "website",
      url: "https://example.com",
    },
  ],
  images: [
    {
      id: crypto.randomUUID(),
      storage_path: "",
      original_filename: "test.png",
    },
  ],
};
idea.images[0].storage_path = `${alice}/${idea.id}/${idea.images[0].id}`;
async function asUser(id: string | null) {
  await db.exec(
    `reset role; set role ${id ? "authenticated" : "anon"}; set request.jwt.claim.sub = '${id || ""}';`,
  );
}
async function save(document: unknown, version: number) {
  return db.query<{ document: typeof idea }>(
    "select public.save_idea($1::jsonb,$2::integer) as document",
    [JSON.stringify(document), version],
  );
}
beforeAll(async () => {
  db = new PGlite();
  // Only Supabase-managed schemas are stubbed. Application tables, RPCs, policies,
  // constraints and transactions below are the unmodified production migration.
  await db.exec(`
 create role anon; create role authenticated;
 create schema auth; create schema storage;
 create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1] $$;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
 alter table storage.objects enable row level security;
 grant usage on schema public,auth,storage to anon,authenticated;
 grant select,insert,update,delete on storage.objects to anon,authenticated;
 insert into auth.users values('${alice}'),('${bob}');
 `);
  await db.exec(
    await readFile(
      new URL(
        "../supabase/migrations/202610270001_initial.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await asUser(alice);
  await save(idea, 0);
}, 30000);
afterAll(async () => {
  await db?.close();
});
describe("production migration in embedded PostgreSQL", () => {
  it("returns the normalized idea aggregate under owner RLS", async () => {
    await asUser(alice);
    const result = await db.query<{ ideas: (typeof idea)[] }>(
      "select public.list_ideas() as ideas",
    );
    expect(result.rows[0].ideas[0]).toMatchObject({
      title: idea.title,
      tags: ["db-test"],
      version: 1,
      links: idea.links,
      images: idea.images,
    });
  });
  it("hides all five personal tables from another user and anonymous callers", async () => {
    for (const id of [bob, null]) {
      await asUser(id);
      for (const table of [
        "ideas",
        "tags",
        "idea_tags",
        "idea_links",
        "idea_images",
      ]) {
        if (id)
          expect(
            (await db.query(`select * from public.${table}`)).rows,
          ).toHaveLength(0);
        else
          await expect(
            db.query(`select * from public.${table}`),
          ).rejects.toThrow(/permission denied/);
      }
    }
    await expect(db.query("select public.list_ideas()")).rejects.toThrow(
      /permission denied/,
    );
  });
  it("rejects owner spoofing and foreign links, images and tags", async () => {
    await asUser(bob);
    await expect(save(idea, 1)).rejects.toThrow(/OWNER_MISMATCH/);
    await expect(
      db.query(
        "insert into public.idea_links(id,idea_id,type,label,url) values($1,$2,$3,$4,$5)",
        [
          crypto.randomUUID(),
          idea.id,
          "website",
          "intrusion",
          "https://example.com",
        ],
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      db.query(
        "insert into public.idea_images(id,idea_id,storage_path,original_filename) values($1,$2,$3,$4)",
        [
          crypto.randomUUID(),
          idea.id,
          `${bob}/${idea.id}/attack`,
          "attack.png",
        ],
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      db.query("insert into public.idea_tags(idea_id,tag_id) values($1,$2)", [
        idea.id,
        crypto.randomUUID(),
      ]),
    ).rejects.toThrow(/row-level security/);
    await expect(
      db.query("insert into public.tags(user_id,name) values($1,$2)", [
        alice,
        "intrusion",
      ]),
    ).rejects.toThrow(/row-level security/);
  });
  it("blocks cross-user update and delete on each personal table", async () => {
    await asUser(bob);
    for (const [table, change] of [
      ["ideas", "title='intrusion',version=version+1"],
      ["tags", "name='intrusion'"],
      ["idea_links", "label='intrusion'"],
      ["idea_images", "original_filename='intrusion'"],
      ["idea_tags", "tag_id=tag_id"],
    ]) {
      expect(
        (await db.query(`update public.${table} set ${change} returning *`))
          .rows,
      ).toHaveLength(0);
      expect(
        (await db.query(`delete from public.${table} returning *`)).rows,
      ).toHaveLength(0);
    }
  });
  it("enforces private Storage folder ownership", async () => {
    await asUser(alice);
    await db.query(
      "insert into storage.objects(bucket_id,name) values($1,$2)",
      ["idea-images", idea.images[0].storage_path],
    );
    await asUser(bob);
    expect((await db.query("select * from storage.objects")).rows).toHaveLength(
      0,
    );
    expect(
      (await db.query("delete from storage.objects returning *")).rows,
    ).toHaveLength(0);
    await expect(
      db.query("insert into storage.objects(bucket_id,name) values($1,$2)", [
        "idea-images",
        `${alice}/${idea.id}/attack`,
      ]),
    ).rejects.toThrow(/row-level security/);
    await asUser(null);
    expect((await db.query("select * from storage.objects")).rows).toHaveLength(
      0,
    );
  });
  it("detects stale saves and rolls back every child change on failure", async () => {
    await asUser(alice);
    await save({ ...idea, title: "server change" }, 1);
    await expect(save({ ...idea, title: "stale change" }, 1)).rejects.toThrow(
      /VERSION_CONFLICT/,
    );
    await expect(
      save(
        {
          ...idea,
          title: "invalid transaction",
          tags: ["should roll back"],
          links: [{ ...idea.links[0], url: "javascript:alert(1)" }],
        },
        2,
      ),
    ).rejects.toThrow(/check constraint/);
    const result = await db.query<{ ideas: (typeof idea)[] }>(
      "select public.list_ideas() as ideas",
    );
    expect(result.rows[0].ideas[0]).toMatchObject({
      title: "server change",
      tags: ["db-test"],
      version: 2,
    });
  });
  it("rejects image paths owned by another user even for owned ideas", async () => {
    await asUser(alice);
    await expect(
      save(
        {
          ...idea,
          images: [
            { ...idea.images[0], storage_path: `${bob}/${idea.id}/stolen` },
          ],
        },
        2,
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
