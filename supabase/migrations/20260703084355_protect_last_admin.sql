create or replace function public.protect_last_admin()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if old.is_admin and not new.is_admin then
    if (select count(*) from public.profiles where is_admin) <= 1 then
      raise exception 'Cannot remove the last admin';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_last_admin on public.profiles;
create trigger protect_last_admin
  before update on public.profiles
  for each row execute function public.protect_last_admin();
