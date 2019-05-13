select execute($$

insert into migrations (id, description) values ('0008', 'on_delete_cascade');

ALTER TABLE potential_payments_ads
  DROP CONSTRAINT potential_payments_ads_payout_report_id_fkey;

ALTER TABLE potential_payments_ads
  ADD CONSTRAINT cascade_payout_report_id
  FOREIGN KEY (payout_report_id)
  REFERENCES payout_reports_ads(id)
  ON DELETE CASCADE;

$$) where not exists (select * from migrations where id = '0008');
