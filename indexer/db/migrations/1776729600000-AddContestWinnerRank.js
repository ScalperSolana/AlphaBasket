module.exports = class AddContestWinnerRank1776729600000 {
  name = 'AddContestWinnerRank1776729600000'

  async up(queryRunner) {
    await queryRunner.query(`ALTER TABLE "contest_day_winner" ADD "rank" integer`);
    await queryRunner.query(`
      WITH ranked AS (
        SELECT
          "id",
          ROW_NUMBER() OVER (
            PARTITION BY "day_id"
            ORDER BY "realized_profit" DESC, "user" ASC
          ) AS "rank"
        FROM "contest_day_winner"
      )
      UPDATE "contest_day_winner" winner
      SET "rank" = ranked."rank"
      FROM ranked
      WHERE winner."id" = ranked."id"
    `);
    await queryRunner.query(`ALTER TABLE "contest_day_winner" ALTER COLUMN "rank" SET NOT NULL`);
  }

  async down(queryRunner) {
    await queryRunner.query(`ALTER TABLE "contest_day_winner" DROP COLUMN "rank"`);
  }
}
