select execute($$

alter table if exists transactions
drop column if exists inserted_at;

delete from migrations where id = '0019';

$$) where exists (select * from migrations where id = '0019');
