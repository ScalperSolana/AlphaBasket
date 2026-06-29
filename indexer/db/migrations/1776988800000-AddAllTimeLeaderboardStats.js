module.exports = class AddAllTimeLeaderboardStats1776988800000 {
  name = "AddAllTimeLeaderboardStats1776988800000";

  async up(queryRunner) {
    await queryRunner.query(`
      CREATE TABLE "all_time_basket_stat" (
        "id" character varying NOT NULL,
        "basket_id" character varying NOT NULL,
        "total_payout" numeric NOT NULL,
        "total_realized_profit" numeric NOT NULL,
        "total_principal" numeric NOT NULL,
        "participant_count" integer NOT NULL,
        "updated_at" TIMESTAMPTZ NOT NULL,
        CONSTRAINT "PK_all_time_basket_stat_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_all_time_basket_stat_basket_id" ON "all_time_basket_stat" ("basket_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_all_time_basket_stat_total_payout" ON "all_time_basket_stat" ("total_payout")`);
    await queryRunner.query(`CREATE INDEX "IDX_all_time_basket_stat_total_realized_profit" ON "all_time_basket_stat" ("total_realized_profit")`);
    await queryRunner.query(`CREATE INDEX "IDX_all_time_basket_stat_updated_at" ON "all_time_basket_stat" ("updated_at")`);

    await queryRunner.query(`
      INSERT INTO "all_time_basket_stat" (
        "id",
        "basket_id",
        "total_payout",
        "total_realized_profit",
        "total_principal",
        "participant_count",
        "updated_at"
      )
      SELECT
        dbc."basket_id" AS "id",
        dbc."basket_id" AS "basket_id",
        COALESCE(SUM(dbc."payout"), 0) AS "total_payout",
        COALESCE(SUM(dbc."realized_profit"), 0) AS "total_realized_profit",
        COALESCE(SUM(dbc."principal"), 0) AS "total_principal",
        COUNT(*)::integer AS "participant_count",
        COALESCE(MAX(dbc."finalized_at"), NOW()) AS "updated_at"
      FROM "daily_basket_contribution" dbc
      GROUP BY dbc."basket_id"
    `);

    await queryRunner.query(`
      CREATE TABLE "all_time_agent_stat" (
        "id" character varying NOT NULL,
        "address" character varying NOT NULL,
        "public_id" character varying NOT NULL,
        "basket_count" integer NOT NULL,
        "total_rewards" numeric NOT NULL,
        "basket_ids" jsonb NOT NULL,
        "updated_at" TIMESTAMPTZ NOT NULL,
        CONSTRAINT "PK_all_time_agent_stat_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_all_time_agent_stat_address" ON "all_time_agent_stat" ("address")`);
    await queryRunner.query(`CREATE INDEX "IDX_all_time_agent_stat_public_id" ON "all_time_agent_stat" ("public_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_all_time_agent_stat_basket_count" ON "all_time_agent_stat" ("basket_count")`);
    await queryRunner.query(`CREATE INDEX "IDX_all_time_agent_stat_total_rewards" ON "all_time_agent_stat" ("total_rewards")`);
    await queryRunner.query(`CREATE INDEX "IDX_all_time_agent_stat_updated_at" ON "all_time_agent_stat" ("updated_at")`);

    await queryRunner.query(`
      INSERT INTO "all_time_agent_stat" (
        "id",
        "address",
        "public_id",
        "basket_count",
        "total_rewards",
        "basket_ids",
        "updated_at"
      )
      SELECT
        lower(src."address") AS "id",
        src."address" AS "address",
        src."public_id" AS "public_id",
        src."basket_count" AS "basket_count",
        src."total_rewards" AS "total_rewards",
        src."basket_ids" AS "basket_ids",
        src."updated_at" AS "updated_at"
      FROM (
        SELECT
          b."creator" AS "address",
          b."creator_public_id" AS "public_id",
          COUNT(*)::integer AS "basket_count",
          COALESCE(
            (
              SELECT SUM(cdw."reward")
              FROM "contest_day_winner" cdw
              WHERE lower(cdw."user") = lower(b."creator")
            ),
            0
          ) AS "total_rewards",
          jsonb_agg(b."id" ORDER BY b."basket_id") AS "basket_ids",
          GREATEST(
            COALESCE(MAX(b."created_at"), NOW()),
            COALESCE(
              (
                SELECT MAX(cdp."updated_at")
                FROM "contest_day_winner" cdw
                JOIN "contest_day_projection" cdp
                  ON cdp."id" = cdw."day_id"
                WHERE lower(cdw."user") = lower(b."creator")
              ),
              to_timestamp(0)
            )
          ) AS "updated_at"
        FROM "basket" b
        WHERE lower(b."asset_kind") = 'bet'
        GROUP BY b."creator", b."creator_public_id"
      ) src
    `);
  }

  async down(queryRunner) {
    await queryRunner.query(`DROP INDEX "public"."IDX_all_time_agent_stat_updated_at"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_all_time_agent_stat_total_rewards"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_all_time_agent_stat_basket_count"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_all_time_agent_stat_public_id"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_all_time_agent_stat_address"`);
    await queryRunner.query(`DROP TABLE "all_time_agent_stat"`);

    await queryRunner.query(`DROP INDEX "public"."IDX_all_time_basket_stat_updated_at"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_all_time_basket_stat_total_realized_profit"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_all_time_basket_stat_total_payout"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_all_time_basket_stat_basket_id"`);
    await queryRunner.query(`DROP TABLE "all_time_basket_stat"`);
  }
};
