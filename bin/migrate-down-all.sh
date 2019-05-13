#!/bin/sh
psql $DATABASE_URL -U eyeshade --single-transaction -v ON_ERROR_STOP=1 -f ./migrations/0008_on_delete_cascade/down.sql
psql $DATABASE_URL -U eyeshade --single-transaction -v ON_ERROR_STOP=1 -f ./migrations/0007_potential_payments_ads/down.sql
psql $DATABASE_URL -U eyeshade --single-transaction -v ON_ERROR_STOP=1 -f ./migrations/0006_payout_reports_ads/down.sql
psql $DATABASE_URL -U eyeshade --single-transaction -v ON_ERROR_STOP=1 -f ./migrations/0005_account_types/down.sql
psql $DATABASE_URL -U eyeshade --single-transaction -v ON_ERROR_STOP=1 -f ./migrations/0004_manual_settlements/down.sql
psql $DATABASE_URL -U eyeshade --single-transaction -v ON_ERROR_STOP=1 -f ./migrations/0003_ads/down.sql
psql $DATABASE_URL -U eyeshade --single-transaction -v ON_ERROR_STOP=1 -f ./migrations/0002_voting/down.sql
psql $DATABASE_URL -U eyeshade --single-transaction -v ON_ERROR_STOP=1 -f ./migrations/0001_transactions/down.sql
psql $DATABASE_URL -U eyeshade --single-transaction -v ON_ERROR_STOP=1 -f ./migrations/0000_initial/down.sql
