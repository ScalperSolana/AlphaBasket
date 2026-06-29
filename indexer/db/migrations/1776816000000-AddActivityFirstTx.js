module.exports = class AddActivityFirstTx1776816000000 {
  name = "AddActivityFirstTx1776816000000";

  async up(queryRunner) {
    await queryRunner.query(`ALTER TABLE "daily_user_activity_aggregate" ADD "first_tx_at" TIMESTAMPTZ`);
    await queryRunner.query(`ALTER TABLE "daily_user_activity_aggregate" ADD "first_tx_block" numeric`);
    await queryRunner.query(`ALTER TABLE "daily_user_activity_aggregate" ADD "first_tx_message_id" character varying`);
    await queryRunner.query(`
      UPDATE "daily_user_activity_aggregate"
      SET
        "first_tx_at" = "last_tx_at",
        "first_tx_block" = "last_tx_block",
        "first_tx_message_id" = "last_tx_message_id"
    `);
    await queryRunner.query(`ALTER TABLE "daily_user_activity_aggregate" ALTER COLUMN "first_tx_at" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "daily_user_activity_aggregate" ALTER COLUMN "first_tx_block" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "daily_user_activity_aggregate" ALTER COLUMN "first_tx_message_id" SET NOT NULL`);
    await queryRunner.query(`CREATE INDEX "IDX_daily_user_activity_aggregate_first_tx_at" ON "daily_user_activity_aggregate" ("first_tx_at")`);
  }

  async down(queryRunner) {
    await queryRunner.query(`DROP INDEX "public"."IDX_daily_user_activity_aggregate_first_tx_at"`);
    await queryRunner.query(`ALTER TABLE "daily_user_activity_aggregate" DROP COLUMN "first_tx_message_id"`);
    await queryRunner.query(`ALTER TABLE "daily_user_activity_aggregate" DROP COLUMN "first_tx_block"`);
    await queryRunner.query(`ALTER TABLE "daily_user_activity_aggregate" DROP COLUMN "first_tx_at"`);
  }
};
