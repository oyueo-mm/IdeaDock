-- Run once in the Supabase SQL editor or with `supabase db push`.
begin;
create table public.ideas (
 id uuid primary key, user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 title text not null check (length(trim(title)) between 1 and 2000),
 content jsonb not null default '{"type":"doc","content":[]}'::jsonb check (jsonb_typeof(content)='object' and octet_length(content::text)<2000000),
 plain_text text not null default '' check (length(plain_text)<500000),
 is_completed boolean not null default false, is_pinned boolean not null default false,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 deleted_at timestamptz, version integer not null default 1 check (version>0)
);
create index ideas_user_updated on public.ideas(user_id, updated_at desc);
create table public.tags (
 id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 name text not null check (length(trim(name)) between 1 and 50), unique(user_id,name)
);
create table public.idea_tags (idea_id uuid not null references public.ideas(id) on delete cascade, tag_id uuid not null references public.tags(id) on delete cascade, primary key(idea_id,tag_id));
create index idea_tags_tag on public.idea_tags(tag_id);
create table public.idea_links (
 id uuid primary key, idea_id uuid not null references public.ideas(id) on delete cascade,
 type text not null check(type in ('website','github')), label text not null check(length(label) between 1 and 200),
 url text not null check(length(url)<=4000 and url ~ '^https?://[^[:space:]/@]+([/:?#][^[:space:]]*)?$')
);
create index idea_links_idea on public.idea_links(idea_id);
create table public.idea_images (
 id uuid primary key, idea_id uuid not null references public.ideas(id) on delete cascade,
 storage_path text not null unique, original_filename text not null check(length(original_filename)<=500), created_at timestamptz not null default now()
);
create index idea_images_idea on public.idea_images(idea_id);

alter table public.ideas enable row level security;
alter table public.tags enable row level security;
alter table public.idea_tags enable row level security;
alter table public.idea_links enable row level security;
alter table public.idea_images enable row level security;
create policy ideas_owner on public.ideas for all to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));
create policy tags_owner on public.tags for all to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));
create policy idea_tags_owner on public.idea_tags for all to authenticated
 using(exists(select 1 from public.ideas i where i.id=idea_id and i.user_id=(select auth.uid())) and exists(select 1 from public.tags t where t.id=tag_id and t.user_id=(select auth.uid())))
 with check(exists(select 1 from public.ideas i where i.id=idea_id and i.user_id=(select auth.uid())) and exists(select 1 from public.tags t where t.id=tag_id and t.user_id=(select auth.uid())));
create policy links_owner on public.idea_links for all to authenticated
 using(exists(select 1 from public.ideas i where i.id=idea_id and i.user_id=(select auth.uid())))
 with check(exists(select 1 from public.ideas i where i.id=idea_id and i.user_id=(select auth.uid())));
create policy images_owner on public.idea_images for all to authenticated
 using(exists(select 1 from public.ideas i where i.id=idea_id and i.user_id=(select auth.uid())))
 with check(exists(select 1 from public.ideas i where i.id=idea_id and i.user_id=(select auth.uid())) and storage_path like (auth.uid()::text||'/'||idea_id::text||'/%'));

create view public.idea_documents with (security_invoker=true) as
 select i.*,
 coalesce((select jsonb_agg(t.name order by t.name) from public.idea_tags it join public.tags t on t.id=it.tag_id where it.idea_id=i.id),'[]'::jsonb) as tags,
 coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'type',l.type,'label',l.label,'url',l.url) order by l.id) from public.idea_links l where l.idea_id=i.id),'[]'::jsonb) as links,
 coalesce((select jsonb_agg(jsonb_build_object('id',im.id,'storage_path',im.storage_path,'original_filename',im.original_filename) order by im.created_at,im.id) from public.idea_images im where im.idea_id=i.id),'[]'::jsonb) as images
 from public.ideas i;

create function public.list_ideas() returns jsonb language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(d) order by d.updated_at desc),'[]'::jsonb) from public.idea_documents d where d.user_id=auth.uid();
$$;
create function public.save_idea(document jsonb, expected_version integer) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare idea_uuid uuid := (document->>'id')::uuid; owner uuid := auth.uid(); changed uuid; item jsonb; tag_uuid uuid; result jsonb;
begin
 if owner is null then raise exception 'AUTH_REQUIRED'; end if;
 if (document->>'user_id')::uuid is distinct from owner then raise exception 'OWNER_MISMATCH'; end if;
 if jsonb_typeof(document->'tags') is distinct from 'array' or jsonb_typeof(document->'links') is distinct from 'array' or jsonb_typeof(document->'images') is distinct from 'array' then raise exception 'INVALID_ARRAY'; end if;
 if jsonb_array_length(document->'tags')>100 or jsonb_array_length(document->'links')>100 or jsonb_array_length(document->'images')>12 then raise exception 'TOO_MANY_ITEMS'; end if;
 if expected_version=0 then
  insert into public.ideas(id,user_id,title,content,plain_text,is_completed,is_pinned,deleted_at)
  values(idea_uuid,owner,document->>'title',document->'content',coalesce(document->>'plain_text',''),(document->>'is_completed')::boolean,(document->>'is_pinned')::boolean,(document->>'deleted_at')::timestamptz)
  on conflict(id) do nothing returning id into changed;
 else
  update public.ideas set title=document->>'title',content=document->'content',plain_text=coalesce(document->>'plain_text',''),
  is_completed=(document->>'is_completed')::boolean,is_pinned=(document->>'is_pinned')::boolean,deleted_at=(document->>'deleted_at')::timestamptz,updated_at=clock_timestamp(),version=version+1
  where id=idea_uuid and user_id=owner and version=expected_version returning id into changed;
 end if;
 if changed is null then raise exception 'VERSION_CONFLICT'; end if;
 delete from public.idea_tags where idea_id=idea_uuid;
 for item in select value from jsonb_array_elements(document->'tags') loop
  insert into public.tags(user_id,name) values(owner,item#>>'{}') on conflict(user_id,name) do update set name=excluded.name returning id into tag_uuid;
  insert into public.idea_tags(idea_id,tag_id) values(idea_uuid,tag_uuid) on conflict do nothing;
 end loop;
 delete from public.idea_links where idea_id=idea_uuid;
 for item in select value from jsonb_array_elements(document->'links') loop
  insert into public.idea_links(id,idea_id,type,label,url) values((item->>'id')::uuid,idea_uuid,item->>'type',item->>'label',item->>'url');
 end loop;
 delete from public.idea_images where idea_id=idea_uuid;
 for item in select value from jsonb_array_elements(document->'images') loop
  insert into public.idea_images(id,idea_id,storage_path,original_filename) values((item->>'id')::uuid,idea_uuid,item->>'storage_path',item->>'original_filename');
 end loop;
 select to_jsonb(d) into result from public.idea_documents d where d.id=idea_uuid;
 return result;
end;
$$;

-- The app performs aggregate mutations through the version-checked RPC.
-- Its security-invoker execution requires table privileges; RLS still protects
-- every direct table request, and a trigger rejects unversioned idea updates.
create function public.guard_idea_version() returns trigger language plpgsql set search_path='' as $$
begin
 if new.user_id<>old.user_id or new.id<>old.id or new.created_at<>old.created_at then raise exception 'IMMUTABLE_IDENTITY'; end if;
 if new.version<>old.version+1 then raise exception 'VERSION_INCREMENT_REQUIRED'; end if;
 return new;
end; $$;
create trigger guard_idea_version before update on public.ideas for each row execute function public.guard_idea_version();

revoke all on public.ideas,public.tags,public.idea_tags,public.idea_links,public.idea_images,public.idea_documents from anon;
grant select,insert,update,delete on public.ideas,public.tags,public.idea_tags,public.idea_links,public.idea_images to authenticated;
grant select on public.idea_documents to authenticated;
revoke all on function public.list_ideas(),public.save_idea(jsonb,integer) from public,anon;
grant execute on function public.list_ideas(),public.save_idea(jsonb,integer) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('idea-images','idea-images',false,5242880,array['image/png','image/jpeg','image/webp','image/gif']);
create policy image_object_read on storage.objects for select to authenticated using(bucket_id='idea-images' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy image_object_insert on storage.objects for insert to authenticated with check(bucket_id='idea-images' and (storage.foldername(name))[1]=(select auth.uid())::text and array_length(storage.foldername(name),1)=2);
create policy image_object_delete on storage.objects for delete to authenticated using(bucket_id='idea-images' and (storage.foldername(name))[1]=(select auth.uid())::text);
commit;
