select execute($$

alter table potential_payments_ads drop constraint IF EXISTS cascade_payout_report_id;

ALTER TABLE potential_payments_ads
  ADD CONSTRAINT cascade_payout_report_id
  FOREIGN KEY (payout_report_id)
  REFERENCES payout_reports_ads(id);

delete from migrations where id = '0008';

$$) where exists (select * from migrations where id = '0008');
