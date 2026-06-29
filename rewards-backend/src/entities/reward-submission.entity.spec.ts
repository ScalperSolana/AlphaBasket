import { DataSource } from 'typeorm';
import { RewardSubmission } from './reward-submission.entity';

describe('RewardSubmission entity', () => {
  it('uses an explicit postgres column type for nullable xUsername', async () => {
    const dataSource = new DataSource({
      type: 'postgres',
      host: 'localhost',
      username: 'test',
      password: 'test',
      database: 'test',
      entities: [RewardSubmission],
    });

    await (dataSource as unknown as { buildMetadatas: () => Promise<void> }).buildMetadatas();

    const metadata = dataSource.getMetadata(RewardSubmission);
    const column = metadata.findColumnWithPropertyName('xUsername');

    expect(column?.type).toBe('character varying');
  });
});
