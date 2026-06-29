module.exports = class InitDailyContestIndexer1762286400000 {
  name = "InitDailyContestIndexer1762286400000";

  async up(queryRunner) {
    await queryRunner.query(`
      CREATE TABLE "basket" (
        "id" character varying NOT NULL,
        "basket_id" numeric NOT NULL,
        "basket_program_id" character varying NOT NULL,
        "asset_kind" character varying NOT NULL,
        "creator" character varying NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL,
        "status" character varying NOT NULL,
        CONSTRAINT "PK_basket_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_basket_basket_id" ON "basket" ("basket_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_basket_program_id" ON "basket" ("basket_program_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_basket_asset_kind" ON "basket" ("asset_kind")`);
    await queryRunner.query(`CREATE INDEX "IDX_basket_creator" ON "basket" ("creator")`);
    await queryRunner.query(`CREATE INDEX "IDX_basket_created_at" ON "basket" ("created_at")`);
    await queryRunner.query(`CREATE INDEX "IDX_basket_status" ON "basket" ("status")`);

    await queryRunner.query(`
      CREATE TABLE "basket_settlement" (
        "id" character varying NOT NULL,
        "basket_id" character varying NOT NULL,
        "day_id" numeric,
        "finalized_at" TIMESTAMPTZ,
        "payout_per_share" numeric,
        "status" character varying NOT NULL,
        CONSTRAINT "PK_basket_settlement_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_basket_settlement_basket_id" FOREIGN KEY ("basket_id") REFERENCES "basket"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_basket_settlement_basket_id" ON "basket_settlement" ("basket_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_basket_settlement_day_id" ON "basket_settlement" ("day_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_basket_settlement_finalized_at" ON "basket_settlement" ("finalized_at")`);
    await queryRunner.query(`CREATE INDEX "IDX_basket_settlement_status" ON "basket_settlement" ("status")`);

    await queryRunner.query(`
      CREATE TABLE "chip_position" (
        "id" character varying NOT NULL,
        "basket_id" character varying NOT NULL,
        "user" character varying NOT NULL,
        "shares" numeric NOT NULL,
        "index_at_creation_bps" integer NOT NULL,
        "claimed" boolean NOT NULL,
        "updated_at" TIMESTAMPTZ NOT NULL,
        CONSTRAINT "PK_chip_position_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_chip_position_basket_id" FOREIGN KEY ("basket_id") REFERENCES "basket"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_chip_position_basket_id" ON "chip_position" ("basket_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_chip_position_user" ON "chip_position" ("user")`);
    await queryRunner.query(`CREATE INDEX "IDX_chip_position_updated_at" ON "chip_position" ("updated_at")`);

    await queryRunner.query(`
      CREATE TABLE "daily_basket_contribution" (
        "id" character varying NOT NULL,
        "day_id" numeric NOT NULL,
        "basket_id" character varying NOT NULL,
        "user" character varying NOT NULL,
        "realized_profit" numeric NOT NULL,
        "payout" numeric NOT NULL,
        "principal" numeric NOT NULL,
        "finalized_at" TIMESTAMPTZ NOT NULL,
        CONSTRAINT "PK_daily_basket_contribution_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_daily_basket_contribution_basket_id" FOREIGN KEY ("basket_id") REFERENCES "basket"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_daily_basket_contribution_day_id" ON "daily_basket_contribution" ("day_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_daily_basket_contribution_basket_id" ON "daily_basket_contribution" ("basket_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_daily_basket_contribution_user" ON "daily_basket_contribution" ("user")`);
    await queryRunner.query(`CREATE INDEX "IDX_daily_basket_contribution_finalized_at" ON "daily_basket_contribution" ("finalized_at")`);

    await queryRunner.query(`
      CREATE TABLE "daily_user_aggregate" (
        "id" character varying NOT NULL,
        "day_id" numeric NOT NULL,
        "user" character varying NOT NULL,
        "realized_profit" numeric NOT NULL,
        "basket_count" integer NOT NULL,
        "updated_at" TIMESTAMPTZ NOT NULL,
        CONSTRAINT "PK_daily_user_aggregate_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_daily_user_aggregate_day_id" ON "daily_user_aggregate" ("day_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_daily_user_aggregate_user" ON "daily_user_aggregate" ("user")`);
    await queryRunner.query(`CREATE INDEX "IDX_daily_user_aggregate_updated_at" ON "daily_user_aggregate" ("updated_at")`);

    await queryRunner.query(`
      CREATE TABLE "contest_day_projection" (
        "id" character varying NOT NULL,
        "day_id" numeric NOT NULL,
        "status" character varying NOT NULL,
        "max_realized_profit" numeric,
        "winner_count" integer NOT NULL,
        "total_reward" numeric,
        "settled_on_chain" boolean NOT NULL,
        "indexer_complete" boolean NOT NULL,
        "settlement_allowed_at" TIMESTAMPTZ NOT NULL,
        "settled_at" TIMESTAMPTZ,
        "result_hash" character varying,
        "evidence_hash" character varying,
        "updated_at" TIMESTAMPTZ NOT NULL,
        CONSTRAINT "PK_contest_day_projection_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_contest_day_projection_day_id" UNIQUE ("day_id")
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_contest_day_projection_status" ON "contest_day_projection" ("status")`);
    await queryRunner.query(`CREATE INDEX "IDX_contest_day_projection_settled_on_chain" ON "contest_day_projection" ("settled_on_chain")`);
    await queryRunner.query(`CREATE INDEX "IDX_contest_day_projection_indexer_complete" ON "contest_day_projection" ("indexer_complete")`);
    await queryRunner.query(`CREATE INDEX "IDX_contest_day_projection_settlement_allowed_at" ON "contest_day_projection" ("settlement_allowed_at")`);
    await queryRunner.query(`CREATE INDEX "IDX_contest_day_projection_settled_at" ON "contest_day_projection" ("settled_at")`);
    await queryRunner.query(`CREATE INDEX "IDX_contest_day_projection_updated_at" ON "contest_day_projection" ("updated_at")`);

    await queryRunner.query(`
      CREATE TABLE "contest_day_winner" (
        "id" character varying NOT NULL,
        "day_id" character varying NOT NULL,
        "user" character varying NOT NULL,
        "realized_profit" numeric NOT NULL,
        "reward" numeric,
        CONSTRAINT "PK_contest_day_winner_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_contest_day_winner_day_id" FOREIGN KEY ("day_id") REFERENCES "contest_day_projection"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_contest_day_winner_day_id" ON "contest_day_winner" ("day_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_contest_day_winner_user" ON "contest_day_winner" ("user")`);

    await queryRunner.query(`
      CREATE TABLE "indexer_state" (
        "id" character varying NOT NULL,
        "last_processed_block" numeric,
        "last_processed_at" TIMESTAMPTZ,
        "known_gap_detected" boolean NOT NULL,
        "start_day_id" numeric,
        "last_materialized_day_id" numeric,
        "updated_at" TIMESTAMPTZ NOT NULL,
        CONSTRAINT "PK_indexer_state_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_indexer_state_updated_at" ON "indexer_state" ("updated_at")`);
  }

  async down(queryRunner) {
    await queryRunner.query(`DROP INDEX "public"."IDX_indexer_state_updated_at"`);
    await queryRunner.query(`DROP TABLE "indexer_state"`);

    await queryRunner.query(`DROP INDEX "public"."IDX_contest_day_winner_user"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_contest_day_winner_day_id"`);
    await queryRunner.query(`DROP TABLE "contest_day_winner"`);

    await queryRunner.query(`DROP INDEX "public"."IDX_contest_day_projection_updated_at"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_contest_day_projection_settled_at"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_contest_day_projection_settlement_allowed_at"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_contest_day_projection_indexer_complete"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_contest_day_projection_settled_on_chain"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_contest_day_projection_status"`);
    await queryRunner.query(`DROP TABLE "contest_day_projection"`);

    await queryRunner.query(`DROP INDEX "public"."IDX_daily_user_aggregate_updated_at"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_daily_user_aggregate_user"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_daily_user_aggregate_day_id"`);
    await queryRunner.query(`DROP TABLE "daily_user_aggregate"`);

    await queryRunner.query(`DROP INDEX "public"."IDX_daily_basket_contribution_finalized_at"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_daily_basket_contribution_user"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_daily_basket_contribution_basket_id"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_daily_basket_contribution_day_id"`);
    await queryRunner.query(`DROP TABLE "daily_basket_contribution"`);

    await queryRunner.query(`DROP INDEX "public"."IDX_chip_position_updated_at"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_chip_position_user"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_chip_position_basket_id"`);
    await queryRunner.query(`DROP TABLE "chip_position"`);

    await queryRunner.query(`DROP INDEX "public"."IDX_basket_settlement_status"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_basket_settlement_finalized_at"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_basket_settlement_day_id"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_basket_settlement_basket_id"`);
    await queryRunner.query(`DROP TABLE "basket_settlement"`);

    await queryRunner.query(`DROP INDEX "public"."IDX_basket_status"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_basket_created_at"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_basket_creator"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_basket_asset_kind"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_basket_program_id"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_basket_basket_id"`);
    await queryRunner.query(`DROP TABLE "basket"`);
  }
};
