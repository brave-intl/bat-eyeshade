select execute($$

drop table potential_payments_ads;
drop table payout_reports_ads;
insert into migrations (id, description) values ('0020', 'remove_potential_payments_ads');

$$) where not exists (select * from migrations where id = '0020');
