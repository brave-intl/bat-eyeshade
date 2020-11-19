select execute($$

delete from migrations where id = '0009';

alter table potential_payments_ads
  drop constraint if exists unique_payment_id_payout_report_id;

$$) where exists (select * from migrations where id = '0009');

