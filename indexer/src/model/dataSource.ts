import { DataSource, DefaultNamingStrategy } from "typeorm";
import dotenv from "dotenv";
import { config } from "../config";
import {
  Basket,
  BasketSettlement,
  ChipPosition,
  ContestDayProjection,
  ContestDayWinner,
  DailyBasketContribution,
  DailyUserActivityAggregate,
  DailyUserAggregate,
  IndexerState,
} from "./index";

dotenv.config();

class SnakeNamingStrategy extends DefaultNamingStrategy {
  columnName(
    propertyName: string,
    customName?: string,
    embeddedPrefixes: string[] = []
  ): string {
    const defaultName = super.columnName(
      propertyName,
      customName,
      embeddedPrefixes
    );
    return defaultName.replace(/([A-Z])/g, "_$1").toLowerCase();
  }
}

const AppDataSource = new DataSource({
  type: "postgres",
  url: config.databaseUrl,
  host: config.dbHost,
  port: config.dbPort,
  username: config.dbUser,
  password: config.dbPass,
  database: config.dbName,
  synchronize: false,
  migrationsRun: false,
  logging: process.env.NODE_ENV === "development",
  entities: [
    Basket,
    BasketSettlement,
    ChipPosition,
    DailyBasketContribution,
    DailyUserAggregate,
    DailyUserActivityAggregate,
    ContestDayProjection,
    ContestDayWinner,
    IndexerState,
  ],
  migrations: ["db/migrations/*.js"],
  namingStrategy: new SnakeNamingStrategy(),
});

export default AppDataSource;
