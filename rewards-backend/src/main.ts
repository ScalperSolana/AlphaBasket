import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));

  const isDev = process.env.NODE_ENV !== 'production';
  app.enableCors({
    origin: [
      'https://polybaskets.xyz',
      'https://app.polybaskets.xyz',
      ...(isDev ? ['http://localhost:8080', 'http://localhost:5173'] : []),
    ],
  });

  const port = app.get(ConfigService).getOrThrow<number>('port');
  await app.listen(port, () => {
    console.log(`Rewards backend running on port ${port}`);
  });
}

bootstrap();
