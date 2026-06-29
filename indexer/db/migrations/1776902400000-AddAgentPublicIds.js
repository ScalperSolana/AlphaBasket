const { createHash } = require("node:crypto");

const SALT = process.env.AGENT_PUBLIC_ID_SALT || "polybaskets-agent-public-id-v1";
const PUBLIC_ID_PREFIX = "agent";
const PUBLIC_ID_LENGTH = 12;

const getAgentPublicId = (address) => {
  const digest = createHash("sha256")
    .update(SALT)
    .update(":")
    .update(String(address).trim().toLowerCase())
    .digest("base64url")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();

  return `${PUBLIC_ID_PREFIX}-${digest.slice(0, PUBLIC_ID_LENGTH)}`;
};

const addAndBackfill = async (queryRunner, table, addressColumn, publicIdColumn) => {
  await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "${publicIdColumn}" character varying`);

  const rows = await queryRunner.query(`SELECT DISTINCT "${addressColumn}" AS address FROM "${table}"`);
  for (const row of rows) {
    const address = row.address;
    if (!address) {
      continue;
    }

    await queryRunner.query(
      `UPDATE "${table}" SET "${publicIdColumn}" = $1 WHERE "${addressColumn}" = $2`,
      [getAgentPublicId(address), address],
    );
  }

  await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "${publicIdColumn}" SET NOT NULL`);
  await queryRunner.query(`CREATE INDEX "IDX_${table}_${publicIdColumn}" ON "${table}" ("${publicIdColumn}")`);
};

const dropColumnAndIndex = async (queryRunner, table, publicIdColumn) => {
  await queryRunner.query(`DROP INDEX "public"."IDX_${table}_${publicIdColumn}"`);
  await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "${publicIdColumn}"`);
};

module.exports = class AddAgentPublicIds1776902400000 {
  name = "AddAgentPublicIds1776902400000";

  async up(queryRunner) {
    await addAndBackfill(queryRunner, "basket", "creator", "creator_public_id");
    await addAndBackfill(queryRunner, "chip_position", "user", "user_public_id");
    await addAndBackfill(queryRunner, "daily_basket_contribution", "user", "user_public_id");
    await addAndBackfill(queryRunner, "daily_user_aggregate", "user", "user_public_id");
    await addAndBackfill(queryRunner, "daily_user_activity_aggregate", "user", "user_public_id");
    await addAndBackfill(queryRunner, "contest_day_winner", "user", "user_public_id");
  }

  async down(queryRunner) {
    await dropColumnAndIndex(queryRunner, "contest_day_winner", "user_public_id");
    await dropColumnAndIndex(queryRunner, "daily_user_activity_aggregate", "user_public_id");
    await dropColumnAndIndex(queryRunner, "daily_user_aggregate", "user_public_id");
    await dropColumnAndIndex(queryRunner, "daily_basket_contribution", "user_public_id");
    await dropColumnAndIndex(queryRunner, "chip_position", "user_public_id");
    await dropColumnAndIndex(queryRunner, "basket", "creator_public_id");
  }
};
