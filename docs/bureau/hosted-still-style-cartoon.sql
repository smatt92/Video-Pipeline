-- Bureau of Reality: scene stills as cartoon pictures of the topic (07-Oct-2026, S003 sent back).
-- Paste in Supabase -> SQL Editor -> Run. Expected: "Success. No rows returned".
-- Changes only the bible's still style; the folder bible (channels/bureau-of-reality) carries the same text.
begin;
update channel_bibles
   set world = jsonb_set(world, '{still_style}', to_jsonb('Bold flat 2D cartoon illustration in a modern explainer-animation style: thick clean dark outlines, simple exaggerated shapes, rich saturated colours over a deep navy background, soft cel shading; witty and adult like an editorial cartoon, instantly readable on a phone; not a children''s book, no photorealism, no 3D render.'::text)),
       version = version + 1,
       updated_at = now(),
       updated_by = 'sahil: stills as cartoon pictures of the topic'
 where channel_id = (select id from channels where slug = 'bureau-of-reality');
do $$ begin
  if not exists (select 1 from channel_bibles b join channels c on c.id = b.channel_id
                 where c.slug = 'bureau-of-reality' and b.world->>'still_style' like 'Bold flat 2D cartoon%') then
    raise exception 'still style did not land; nothing changed';
  end if;
end $$;
commit;
