import { Client } from 'pg';
import { config } from 'dotenv';

config();

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const migrationSql = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS reward_submission (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet character varying NOT NULL,
  actor_id character varying NOT NULL,
  task_type character varying NOT NULL,
  tweet_url character varying NOT NULL,
  tweet_id character varying NOT NULL,
  x_username character varying NULL,
  week_key character varying NOT NULL,
  reward_amount_planck numeric(39, 0) NOT NULL,
  grant_id character varying NOT NULL,
  reason character varying NOT NULL,
  status character varying NOT NULL DEFAULT 'pending',
  failure_reason text NULL,
  paid_at timestamp without time zone NULL,
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  updated_at timestamp without time zone NOT NULL DEFAULT now()
);

ALTER TABLE reward_submission ADD COLUMN IF NOT EXISTS failure_reason text NULL;
ALTER TABLE reward_submission ALTER COLUMN failure_reason TYPE text USING failure_reason::text;
ALTER TABLE reward_submission ADD COLUMN IF NOT EXISTS x_username character varying NULL;

CREATE UNIQUE INDEX IF NOT EXISTS reward_submission_actor_task_week_idx
  ON reward_submission (actor_id, task_type, week_key);
CREATE UNIQUE INDEX IF NOT EXISTS reward_submission_x_username_task_week_idx
  ON reward_submission (x_username, task_type, week_key)
  WHERE x_username IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reward_submission_x_username_task_tweet_idx
  ON reward_submission (x_username, task_type, tweet_id)
  WHERE x_username IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reward_submission_grant_id_idx
  ON reward_submission (grant_id);

CREATE TABLE IF NOT EXISTS referral (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer character varying NOT NULL,
  referrer_actor_id character varying NOT NULL,
  friend character varying NOT NULL,
  friend_actor_id character varying NOT NULL,
  status character varying NOT NULL DEFAULT 'active',
  accepted_at timestamp without time zone NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  updated_at timestamp without time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS referral_friend_actor_id_idx
  ON referral (friend_actor_id);
CREATE INDEX IF NOT EXISTS referral_referrer_actor_id_idx
  ON referral (referrer_actor_id);

CREATE TABLE IF NOT EXISTS referral_reward (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer character varying NOT NULL,
  referrer_actor_id character varying NOT NULL,
  friend character varying NOT NULL,
  friend_actor_id character varying NOT NULL,
  milestone integer NOT NULL,
  recipient character varying NOT NULL,
  recipient_actor_id character varying NOT NULL,
  week_key character varying NOT NULL,
  amount_planck numeric(39, 0) NOT NULL,
  grant_id character varying NOT NULL,
  paid_at timestamp without time zone NULL,
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  updated_at timestamp without time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS referral_reward_grant_id_idx
  ON referral_reward (grant_id);

CREATE TABLE IF NOT EXISTS referral_progress (
  friend_actor_id character varying PRIMARY KEY,
  tx_count integer NOT NULL DEFAULT 0,
  active_days integer NOT NULL DEFAULT 0,
  qualifying_active_days integer NOT NULL DEFAULT 0,
  first_tx_at timestamp without time zone NULL,
  last_tx_at timestamp without time zone NULL,
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  updated_at timestamp without time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS referral_progress_updated_at_idx
  ON referral_progress (updated_at);
`;

async function main() {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || '5432'),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    database: required('DB_NAME'),
  });

  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(migrationSql);
    await client.query('COMMIT');
    console.log('Rewards database migration completed');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('Rewards database migration failed');
  console.error(error);
  process.exit(1);
});
