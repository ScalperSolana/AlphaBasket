module.exports = class AddDailyUserActivityAggregate1762732800000 {
  name = "AddDailyUserActivityAggregate1762732800000";

  async up(queryRunner) {
    await queryRunner.query(`
      CREATE TABLE "daily_user_activity_aggregate" (
        "id" character varying NOT NULL,
        "day_id" numeric NOT NULL,
        "user" character varying NOT NULL,
        "tx_count" integer NOT NULL,
        "baskets_made" integer NOT NULL,
        "bets_placed" integer NOT NULL,
        "approves_count" integer NOT NULL,
        "claims_count" integer NOT NULL,
        "last_tx_at" TIMESTAMPTZ NOT NULL,
        "last_tx_block" numeric NOT NULL,
        "last_tx_message_id" character varying NOT NULL,
        "updated_at" TIMESTAMPTZ NOT NULL,
        CONSTRAINT "PK_daily_user_activity_aggregate_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_daily_user_activity_aggregate_day_id" ON "daily_user_activity_aggregate" ("day_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_daily_user_activity_aggregate_user" ON "daily_user_activity_aggregate" ("user")`);
    await queryRunner.query(`CREATE INDEX "IDX_daily_user_activity_aggregate_last_tx_at" ON "daily_user_activity_aggregate" ("last_tx_at")`);
    await queryRunner.query(`CREATE INDEX "IDX_daily_user_activity_aggregate_updated_at" ON "daily_user_activity_aggregate" ("updated_at")`);
  }

  async down(queryRunner) {
    await queryRunner.query(`DROP INDEX "public"."IDX_daily_user_activity_aggregate_updated_at"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_daily_user_activity_aggregate_last_tx_at"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_daily_user_activity_aggregate_user"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_daily_user_activity_aggregate_day_id"`);
    await queryRunner.query(`DROP TABLE "daily_user_activity_aggregate"`);
  }
};
