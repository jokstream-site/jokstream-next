-- Fast, provider-safe TMDB enrichment for homepage discovery.
-- Only exact, unique title matches are attached to provider catalog rows.
alter table public.jok_catalog_metadata
  add column if not exists vote_count integer not null default 0;

create or replace function public.jok_catalog_metadata_upsert_tmdb(
  p_token text,
  p_kind text,
  p_items jsonb
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, jok_private, extensions
as $function$
declare
  v_hash text;
  v_version uuid;
  v_count integer := 0;
begin
  select secret_hash into v_hash
  from jok_private.catalog_sync_secret
  where singleton = true;

  if p_token is null
     or v_hash is null
     or encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex') <> v_hash then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  if p_kind not in ('movie', 'series')
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) > 250 then
    raise exception 'invalid_metadata_batch';
  end if;

  select active_version into v_version
  from public.jok_catalog_state
  where singleton = true;

  if v_version is null then
    return 0;
  end if;

  with incoming as (
    select
      x.tmdb_id,
      btrim(x.title) as title,
      nullif(x.release_date, '')::date as release_date,
      greatest(0, coalesce(x.vote_count, 0)) as vote_count,
      greatest(0, least(10, coalesce(x.vote_average, 0)))::numeric(4,2) as vote_average,
      coalesce(x.overview, '') as overview,
      coalesce(x.poster_path, '') as poster_path,
      coalesce(x.backdrop_path, '') as backdrop_path,
      lower(regexp_replace(regexp_replace(btrim(x.title), '\m(19|20)[0-9]{2}\M', '', 'g'), '[^[:alnum:]]+', ' ', 'g')) as normalized_title
    from jsonb_to_recordset(p_items) as x(
      tmdb_id bigint,
      title text,
      release_date text,
      vote_count integer,
      vote_average numeric,
      overview text,
      poster_path text,
      backdrop_path text
    )
    where x.tmdb_id is not null
      and length(btrim(coalesce(x.title, ''))) between 1 and 300
  ),
  unique_incoming as (
    select *, count(*) over (partition by normalized_title) as candidate_count
    from incoming
  ),
  provider_rows as (
    select
      i.item_id,
      i.name,
      lower(regexp_replace(regexp_replace(btrim(i.name), '\m(19|20)[0-9]{2}\M', '', 'g'), '[^[:alnum:]]+', ' ', 'g')) as normalized_title
    from public.jok_catalog_items i
    where i.version_id = v_version
      and i.kind = p_kind
  ),
  matched as (
    select
      c.tmdb_id, c.release_date, c.vote_count, c.vote_average,
      c.overview, c.poster_path, c.backdrop_path,
      min(p.item_id) as item_id,
      count(p.item_id) as provider_count
    from unique_incoming c
    join provider_rows p on p.normalized_title = c.normalized_title
    where c.candidate_count = 1
    group by c.tmdb_id, c.release_date, c.vote_count, c.vote_average,
      c.overview, c.poster_path, c.backdrop_path, c.candidate_count
    having count(p.item_id) = 1
  )
  insert into public.jok_catalog_metadata(
    kind, item_id, tmdb_id, release_date, vote_count, vote_average,
    overview, poster_path, backdrop_path, match_status, metadata_source, synced_at
  )
  select
    p_kind, item_id, tmdb_id, release_date, vote_count, vote_average,
    nullif(overview, ''), nullif(poster_path, ''), nullif(backdrop_path, ''),
    'matched', 'tmdb', now()
  from matched
  on conflict (kind, item_id) do update set
    tmdb_id = excluded.tmdb_id,
    release_date = excluded.release_date,
    vote_count = excluded.vote_count,
    vote_average = excluded.vote_average,
    overview = excluded.overview,
    poster_path = excluded.poster_path,
    backdrop_path = excluded.backdrop_path,
    match_status = 'matched',
    metadata_source = 'tmdb',
    synced_at = now();

  get diagnostics v_count = row_count;
  return v_count;
end
$function$;

revoke all on function public.jok_catalog_metadata_upsert_tmdb(text, text, jsonb) from public;
grant execute on function public.jok_catalog_metadata_upsert_tmdb(text, text, jsonb) to anon, authenticated;

create or replace function public.jok_catalog_page_sorted(
  p_kind text default null,
  p_query text default null,
  p_category text default null,
  p_sort text default 'name_asc',
  p_genre text default null,
  p_year integer default null,
  p_min_rating numeric default null,
  p_limit integer default 40,
  p_offset integer default 0
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v uuid;
  ts timestamptz;
  n bigint;
  rows jsonb;
  sort_key text := case when p_sort in ('release_newest','release_oldest','rating_highest','name_asc') then p_sort else 'name_asc' end;
begin
  select active_version, updated_at into v, ts
  from public.jok_catalog_state where singleton = true;
  if v is null then return jsonb_build_object('items','[]'::jsonb,'total',0,'updatedAt',null); end if;

  select count(*) into n
  from public.jok_catalog_items i
  left join public.jok_catalog_metadata m on m.kind=i.kind and m.item_id=i.item_id
  where i.version_id=v
    and (p_kind is null or i.kind=p_kind)
    and (coalesce(p_query,'')='' or i.name ilike '%'||p_query||'%' or i.category ilike '%'||p_query||'%')
    and (coalesce(p_category,'')='' or coalesce(nullif(btrim(i.category),''),'Uncategorized')=p_category)
    and (coalesce(p_genre,'')='' or p_genre=any(m.genres))
    and (p_year is null or extract(year from m.release_date)=p_year)
    and (p_min_rating is null or m.vote_average>=p_min_rating)
    and (sort_key <> 'release_newest' or m.release_date is not null)
    and (sort_key <> 'release_oldest' or m.release_date is not null)
    and (sort_key <> 'rating_highest' or (m.vote_average is not null and m.vote_count >= 250));

  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into rows
  from (
    select i.item_id as id,i.name,i.category,i.kind,i.extension,i.image_url,
      m.tmdb_id,m.release_date,m.genres,m.vote_average,m.vote_count,m.overview,
      case when m.poster_path is not null then 'https://image.tmdb.org/t/p/w500'||m.poster_path else null end as poster,
      case when m.backdrop_path is not null then 'https://image.tmdb.org/t/p/w1280'||m.backdrop_path else null end as backdrop,
      m.match_status
    from public.jok_catalog_items i
    left join public.jok_catalog_metadata m on m.kind=i.kind and m.item_id=i.item_id
    where i.version_id=v
      and (p_kind is null or i.kind=p_kind)
      and (coalesce(p_query,'')='' or i.name ilike '%'||p_query||'%' or i.category ilike '%'||p_query||'%')
      and (coalesce(p_category,'')='' or coalesce(nullif(btrim(i.category),''),'Uncategorized')=p_category)
      and (coalesce(p_genre,'')='' or p_genre=any(m.genres))
      and (p_year is null or extract(year from m.release_date)=p_year)
      and (p_min_rating is null or m.vote_average>=p_min_rating)
      and (sort_key <> 'release_newest' or m.release_date is not null)
      and (sort_key <> 'release_oldest' or m.release_date is not null)
      and (sort_key <> 'rating_highest' or (m.vote_average is not null and m.vote_count >= 250))
    order by
      case when sort_key='release_newest' then m.release_date end desc nulls last,
      case when sort_key='release_oldest' then m.release_date end asc nulls last,
      case when sort_key='rating_highest' then m.vote_average end desc nulls last,
      case when sort_key='rating_highest' then m.vote_count end desc nulls last,
      lower(i.name) asc,
      i.item_id asc
    limit greatest(1,least(coalesce(p_limit,40),100))
    offset greatest(0,coalesce(p_offset,0))
  ) t;

  return jsonb_build_object('items',rows,'total',n,'updatedAt',ts);
end
$function$;

create or replace function public.jok_catalog_match_epg_programs(p_titles jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_version uuid;
  v_rows jsonb;
begin
  if jsonb_typeof(p_titles) <> 'array' or jsonb_array_length(p_titles) > 100 then
    raise exception 'invalid_epg_title_batch';
  end if;

  select active_version into v_version
  from public.jok_catalog_state
  where singleton = true;

  if v_version is null then
    return '[]'::jsonb;
  end if;

  with incoming as (
    select distinct btrim(value #>> '{}') as title,
      lower(regexp_replace(regexp_replace(btrim(value #>> '{}'), '\m(19|20)[0-9]{2}\M', '', 'g'), '[^[:alnum:]]+', ' ', 'g')) as normalized_title
    from jsonb_array_elements(p_titles)
    where length(btrim(value #>> '{}')) between 1 and 300
  ),
  matched as (
    select
      incoming.title as program_title,
      i.kind,
      i.item_id,
      m.release_date,
      m.vote_average,
      m.vote_count,
      count(*) over (partition by incoming.normalized_title) as title_match_count
    from incoming
    join public.jok_catalog_items i
      on i.version_id = v_version
     and i.kind in ('movie','series')
     and lower(regexp_replace(regexp_replace(btrim(i.name), '\m(19|20)[0-9]{2}\M', '', 'g'), '[^[:alnum:]]+', ' ', 'g')) = incoming.normalized_title
    join public.jok_catalog_metadata m
      on m.kind = i.kind and m.item_id = i.item_id and m.match_status = 'matched'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'program_title', program_title,
    'kind', kind,
    'item_id', item_id,
    'release_date', release_date,
    'vote_average', vote_average,
    'vote_count', vote_count
  )), '[]'::jsonb)
  into v_rows
  from matched
  where title_match_count = 1;

  return v_rows;
end
$function$;

revoke all on function public.jok_catalog_match_epg_programs(jsonb) from public;
grant execute on function public.jok_catalog_match_epg_programs(jsonb) to anon, authenticated;
