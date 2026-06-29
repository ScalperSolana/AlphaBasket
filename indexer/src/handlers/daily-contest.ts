import { GearApi } from "@gear-js/api";
import { FindOptionsWhere } from "typeorm";
import { DAY_MS, config, emptyDayPolicy } from "../config";
import { getAgentPublicId } from "../helpers/agent-public-id";
import { isSailsEvent, isUserMessageSentEvent } from "../helpers/is";
import {
  AllTimeAgentStat,
  AllTimeBasketStat,
  Basket,
  BasketSettlement,
  ChipPosition,
  ContestDayProjection,
  ContestDayWinner,
  DailyBasketContribution,
  DailyUserActivityAggregate,
  DailyUserAggregate,
  IndexerState,
} from "../model";
import { SailsDecoder } from "../sails-decoder";
import { UserMessageSentEvent } from "../types/gear-events";
import { BaseHandler } from "./base";

const INDEXER_STATE_ID = "daily-contest";
const MAX_DAILY_WINNERS = 5;
const CHIP_ACTIVITY_PNL_DIVISOR = 1_000_000_000_000_000;

type BasketCreatedPayload = {
  basket_id: number | string | bigint;
  creator: string;
  asset_kind: "Vara" | "Bet";
};

type SettlementFinalizedPayload = {
  basket_id: number | string | bigint;
  asset_kind?: "Vara" | "Bet";
  finalized_at: number | string | bigint;
  payout_per_share: number | string | bigint;
};

type BetPlacedPayload = {
  basket_id: number | string | bigint;
  user: string;
  amount: number | string | bigint;
  user_total: number | string | bigint;
  quoted_index_bps: number;
  position_index_at_creation_bps: number;
  quote_nonce: number | string | bigint;
};

type VaraBetPlacedPayload = {
  basket_id: number | string | bigint;
  user: string;
  amount: number | string | bigint;
  user_total: number | string | bigint;
  index_at_creation_bps: number;
};

type BetClaimedPayload = {
  basket_id: number | string | bigint;
  user: string;
  amount: number | string | bigint;
};

type BetTokenApprovedPayload = {
  owner: string;
  spender: string;
  value: number | string | bigint;
  changed: boolean;
};

type BetTokenClaimedPayload = {
  user: string;
  amount: number | string | bigint;
  streak_days: number;
  claimed_at: number | string | bigint;
};

type DaySettledPayload = {
  day_id: number | string | bigint;
  winner_count: number;
  total_reward: number | string | bigint;
  settled_at: number | string | bigint;
  result_hash: string | Uint8Array;
  evidence_hash: string | Uint8Array;
};

type WinnerPayoutPayload = {
  account: string;
  realized_profit: number | string | bigint;
  reward: number | string | bigint;
};

type WinnersPaidPayload = {
  day_id: number | string | bigint;
  payouts: WinnerPayoutPayload[];
};

const toBigIntValue = (value: number | string | bigint): bigint => {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number") {
    return BigInt(Math.trunc(value));
  }

  return BigInt(value);
};

const timestampMsToDate = (value: number | string | bigint): Date =>
  new Date(Number(toBigIntValue(value)));

const dateToTimestampMs = (value: Date): bigint => BigInt(value.getTime());

const hexValue = (value: string | Uint8Array): string => {
  if (typeof value === "string") {
    return value;
  }

  return `0x${Buffer.from(value).toString("hex")}`;
};

const basketEntityId = (basketId: number | string | bigint): string =>
  `${config.basketMarketProgramId}:${String(basketId)}`;

const basketSettlementId = (basketId: number | string | bigint): string =>
  basketEntityId(basketId);

const chipPositionId = (basketId: string, user: string): string =>
  `${basketId}:${user}`;

const dayIdFromTimestamp = (timestampMs: bigint): bigint =>
  (timestampMs - config.contestDayBoundaryOffsetMs) / DAY_MS;

const dailyContributionId = (
  dayId: bigint,
  basketId: string,
  user: string
): string => `${dayId.toString()}:${basketId}:${user}`;

const dailyUserAggregateId = (dayId: bigint, user: string): string =>
  `${dayId.toString()}:${user}`;

const dailyUserActivityAggregateId = (dayId: bigint, user: string): string =>
  `${dayId.toString()}:${user}`;

const contestDayId = (dayId: bigint): string => dayId.toString();

const contestWinnerId = (dayId: bigint, user: string): string =>
  `${dayId.toString()}:${user}`;

const dayStartMs = (dayId: bigint): bigint =>
  dayId * DAY_MS + config.contestDayBoundaryOffsetMs;

const nextDayStartMs = (dayId: bigint): bigint => dayStartMs(dayId + 1n);

const settlementAllowedAtMs = (dayId: bigint): bigint =>
  nextDayStartMs(dayId) + config.settlementGracePeriodMs;

const settlementAllowedAtDate = (dayId: bigint): Date =>
  new Date(Number(settlementAllowedAtMs(dayId)));

const maxCompleteDayId = (headTimestampMs: bigint): bigint | null => {
  const shifted =
    headTimestampMs - config.settlementGracePeriodMs - config.contestDayBoundaryOffsetMs;
  if (shifted <= 0n) {
    return null;
  }

  return (shifted / DAY_MS) - 1n;
};

const isDayCompleteAt = (dayId: bigint, headTimestamp: Date | null): boolean => {
  if (!headTimestamp) {
    return false;
  }

  return dateToTimestampMs(headTimestamp) >= settlementAllowedAtMs(dayId);
};

const computeIndexerComplete = (
  dayId: bigint,
  headTimestamp: Date | null,
  _knownGapDetected: boolean
): boolean => {
  return isDayCompleteAt(dayId, headTimestamp);
};

const sortedWinners = (
  activities: Array<{
    user: string;
    txCount: number;
    realizedProfit: bigint;
    firstTxAt: Date;
    firstTxBlock: bigint;
    firstTxMessageId: string;
    lastTxAt: Date;
    lastTxBlock: bigint;
    lastTxMessageId: string;
    dayId: bigint;
  }>
): Array<{
  user: string;
  txCount: number;
  realizedProfit: bigint;
  firstTxAt: Date;
  firstTxBlock: bigint;
  firstTxMessageId: string;
  lastTxAt: Date;
  lastTxBlock: bigint;
  lastTxMessageId: string;
  dayId: bigint;
}> => {
  const eligible = activities.filter((item) => item.txCount > 0);
  if (!eligible.length) {
    return [];
  }

  const activityIndex = (item: (typeof eligible)[number]): number => {
    const dayStart = Number(dayStartMs(item.dayId));
    const elapsedMs = Math.max(
      0,
      Math.min(Number(DAY_MS), item.firstTxAt.getTime() - dayStart)
    );
    const timeBonus = 1 - elapsedMs / Number(DAY_MS);

    return (
      item.txCount +
      Number(item.realizedProfit) / CHIP_ACTIVITY_PNL_DIVISOR +
      timeBonus * 0.000001
    );
  };

  return [...eligible].sort((left, right) => {
    const scoreDiff = activityIndex(right) - activityIndex(left);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }

    if (left.txCount !== right.txCount) {
      return right.txCount - left.txCount;
    }

    const timestampDiff = left.firstTxAt.getTime() - right.firstTxAt.getTime();
    if (timestampDiff !== 0) {
      return timestampDiff;
    }

    if (left.realizedProfit !== right.realizedProfit) {
      return left.realizedProfit > right.realizedProfit ? -1 : 1;
    }

    if (left.firstTxBlock !== right.firstTxBlock) {
      return left.firstTxBlock < right.firstTxBlock ? -1 : 1;
    }

    if (left.firstTxMessageId !== right.firstTxMessageId) {
      return left.firstTxMessageId.localeCompare(right.firstTxMessageId);
    }

    return left.user.localeCompare(right.user);
  });
};

export class DailyContestHandler extends BaseHandler {
  private decoders = new Map<string, SailsDecoder>();
  private allTimeBasketStatsToSave = new Map<string, AllTimeBasketStat>();
  private allTimeAgentStatsToSave = new Map<string, AllTimeAgentStat>();
  private basketsToSave = new Map<string, Basket>();
  private basketSettlementsToSave = new Map<string, BasketSettlement>();
  private chipPositionsToSave = new Map<string, ChipPosition>();
  private contributionsToSave = new Map<string, DailyBasketContribution>();
  private activitiesToSave = new Map<string, DailyUserActivityAggregate>();
  private aggregatesByDay = new Map<string, DailyUserAggregate[]>();
  private daysToSave = new Map<string, ContestDayProjection>();
  private winnersByDay = new Map<string, ContestDayWinner[]>();
  private aggregateDaysToReplace = new Set<string>();
  private winnerDaysToReplace = new Set<string>();
  private indexerState: IndexerState | null = null;

  constructor() {
    super();
    this.userMessageSentProgramIds = [
      config.basketMarketProgramId,
      config.betLaneProgramId,
      config.dailyContestProgramId,
    ];
    if (config.betTokenProgramId) {
      this.userMessageSentProgramIds.push(config.betTokenProgramId);
    }
  }

  async init(_api?: GearApi): Promise<void> {
    this.decoders.set(
      config.basketMarketProgramId,
      await SailsDecoder.new(config.basketMarketIdlPath)
    );
    this.decoders.set(
      config.betLaneProgramId,
      await SailsDecoder.new(config.betLaneIdlPath)
    );
    if (config.betTokenProgramId) {
      this.decoders.set(
        config.betTokenProgramId,
        await SailsDecoder.new(config.betTokenIdlPath)
      );
    }
    this.decoders.set(
      config.dailyContestProgramId,
      await SailsDecoder.new(config.dailyContestIdlPath)
    );
  }

  clear(): void {
    this.allTimeBasketStatsToSave.clear();
    this.allTimeAgentStatsToSave.clear();
    this.basketsToSave.clear();
    this.basketSettlementsToSave.clear();
    this.chipPositionsToSave.clear();
    this.contributionsToSave.clear();
    this.activitiesToSave.clear();
    this.aggregatesByDay.clear();
    this.daysToSave.clear();
    this.winnersByDay.clear();
    this.aggregateDaysToReplace.clear();
    this.winnerDaysToReplace.clear();
  }

  async process(ctx: any): Promise<void> {
    await super.process(ctx);
    this.indexerState = await this.loadIndexerState();

    for (const block of ctx.blocks) {
      const blockTimestamp = new Date(block.header.timestamp);

      for (const event of block.events) {
        if (!isUserMessageSentEvent(event)) {
          continue;
        }

        const source = event.args.message.source;
        if (!this.decoders.has(source) || !isSailsEvent(event)) {
          continue;
        }

        await this.handleUserMessageSentEvent(event, block.header.height, blockTimestamp);
      }
    }

    const lastBlock = ctx.blocks[ctx.blocks.length - 1];
    if (lastBlock) {
      await this.advanceIndexerHead(
        BigInt(lastBlock.header.height),
        new Date(lastBlock.header.timestamp)
      );
    }
  }

  async save(): Promise<void> {
    for (const dayId of this.aggregateDaysToReplace) {
      const existing = await this.ctx.store.find(DailyUserAggregate, {
        where: { dayId: BigInt(dayId) } as FindOptionsWhere<DailyUserAggregate>,
      });
      if (existing.length > 0) {
        await this.ctx.store.remove(existing);
      }
    }

    for (const dayId of this.winnerDaysToReplace) {
      const existing = await this.ctx.store.find(ContestDayWinner, {
        where: { dayId } as FindOptionsWhere<ContestDayWinner>,
      });
      if (existing.length > 0) {
        await this.ctx.store.remove(existing);
      }
    }

    await this.saveGroup(this.basketsToSave.values(), "baskets");
    await this.saveGroup(this.allTimeBasketStatsToSave.values(), "all-time basket stats");
    await this.saveGroup(this.allTimeAgentStatsToSave.values(), "all-time agent stats");
    await this.saveGroup(this.basketSettlementsToSave.values(), "basket settlements");
    await this.saveGroup(this.chipPositionsToSave.values(), "chip positions");
    await this.saveGroup(this.contributionsToSave.values(), "daily contributions");
    await this.saveGroup(
      this.activitiesToSave.values(),
      "daily activity aggregates"
    );
    await this.saveGroup(
      Array.from(this.aggregatesByDay.values()).reduce<DailyUserAggregate[]>(
        (acc, items) => acc.concat(items),
        []
      ),
      "daily aggregates"
    );
    await this.saveGroup(this.daysToSave.values(), "contest days");
    await this.saveGroup(
      Array.from(this.winnersByDay.values()).reduce<ContestDayWinner[]>(
        (acc, items) => acc.concat(items),
        []
      ),
      "contest winners"
    );

    if (this.indexerState) {
      await this.ctx.store.save(this.indexerState);
    }
  }

  private async saveGroup<T extends { id: string }>(
    items: Iterable<T>,
    label: string
  ): Promise<void> {
    const collection = [...items];
    if (!collection.length) {
      return;
    }

    this.logger.info({ count: collection.length }, `Saving ${label}`);
    await this.ctx.store.save(collection as any[]);
  }

  private async loadIndexerState(): Promise<IndexerState> {
    const existing = await this.ctx.store.findOneBy(IndexerState, {
      id: INDEXER_STATE_ID,
    });

    if (existing) {
      return existing;
    }

    return new IndexerState({
      id: INDEXER_STATE_ID,
      lastProcessedBlock: null,
      lastProcessedAt: null,
      knownGapDetected: false,
      startDayId: null,
      lastMaterializedDayId: null,
      updatedAt: new Date(),
    });
  }

  private async handleUserMessageSentEvent(
    event: UserMessageSentEvent,
    blockHeight: number,
    blockTimestamp: Date
  ): Promise<void> {
    const decoder = this.decoders.get(event.args.message.source);
    if (!decoder) {
      return;
    }

    const service = decoder.service(event.args.message.payload);
    const method = decoder.method(event.args.message.payload);
    const decodedEvent = decoder.decodeEvent(event);
    if (!decodedEvent) {
      console.warn(
        `[indexer] Skipping undecodable Sails payload from program ${event.args.message.source}: service=${service}, method=${method}, messageId=${event.args.message.id}`,
      );
      return;
    }

    const payload = decodedEvent.payload;

    if (event.args.message.source === config.basketMarketProgramId) {
      if (service !== "BasketMarket") {
        return;
      }

      if (method === "BasketCreated") {
        await this.handleBasketCreated(
          payload as BasketCreatedPayload,
          blockHeight,
          blockTimestamp,
          event.args.message.id
        );
      }

      if (method === "SettlementFinalized") {
        await this.handleSettlementFinalized(
          payload as SettlementFinalizedPayload,
          blockHeight,
          blockTimestamp
        );
      }

      if (method === "VaraBetPlaced") {
        await this.handleVaraBetPlaced(
          payload as VaraBetPlacedPayload,
          blockHeight,
          blockTimestamp,
          event.args.message.id
        );
      }

      if (method === "Claimed") {
        await this.handleBetClaimed(
          payload as BetClaimedPayload,
          blockHeight,
          blockTimestamp,
          event.args.message.id
        );
      }

      return;
    }

    if (event.args.message.source === config.betLaneProgramId) {
      if (service !== "BetLane") {
        return;
      }

      if (method === "BetPlaced") {
        await this.handleBetPlaced(
          payload as BetPlacedPayload,
          blockHeight,
          blockTimestamp,
          event.args.message.id
        );
      }

      if (method === "Claimed") {
        await this.handleBetClaimed(
          payload as BetClaimedPayload,
          blockHeight,
          blockTimestamp,
          event.args.message.id
        );
      }

      return;
    }

    if (
      config.betTokenProgramId &&
      event.args.message.source === config.betTokenProgramId
    ) {
      if (service !== "BetToken") {
        return;
      }

      if (method === "Approved") {
        await this.handleBetTokenApproved(
          payload as BetTokenApprovedPayload,
          blockHeight,
          blockTimestamp,
          event.args.message.id
        );
      }

      if (method === "Claimed") {
        await this.handleBetTokenClaimed(
          payload as BetTokenClaimedPayload,
          blockHeight,
          blockTimestamp,
          event.args.message.id
        );
      }

      return;
    }

    if (event.args.message.source === config.dailyContestProgramId) {
      if (service !== "DailyContest") {
        return;
      }

      if (method === "DaySettled") {
        await this.handleDaySettled(payload as DaySettledPayload);
      }

      if (method === "WinnersPaid") {
        await this.handleWinnersPaid(payload as WinnersPaidPayload);
      }
    }
  }

  private async handleBasketCreated(
    payload: BasketCreatedPayload,
    blockHeight: number,
    blockTimestamp: Date,
    messageId: string
  ): Promise<void> {
    const id = basketEntityId(payload.basket_id);
    const creator = String(payload.creator);
    this.basketsToSave.set(
      id,
      new Basket({
        id,
        basketId: String(payload.basket_id),
        basketProgramId: config.basketMarketProgramId,
        assetKind: payload.asset_kind,
        creator,
        creatorPublicId: getAgentPublicId(creator),
        createdAt: blockTimestamp,
        status: "created",
      })
    );

    await this.recordActivity(
      blockTimestamp,
      creator,
      blockHeight,
      messageId,
      { txCount: 1, basketsMade: 1 }
    );

    await this.recomputeAllTimeAgentBasketStats(creator, blockTimestamp);
  }

  private async handleBetPlaced(
    payload: BetPlacedPayload,
    blockHeight: number,
    blockTimestamp: Date,
    messageId: string
  ): Promise<void> {
    const basketId = basketEntityId(payload.basket_id);
    const user = String(payload.user);
    const position = new ChipPosition({
      id: chipPositionId(basketId, user),
      basketId,
      user,
      userPublicId: getAgentPublicId(user),
      shares: toBigIntValue(payload.user_total),
      indexAtCreationBps: payload.position_index_at_creation_bps,
      claimed: false,
      updatedAt: blockTimestamp,
    });

    this.chipPositionsToSave.set(position.id, position);
    await this.recordActivity(
      blockTimestamp,
      user,
      blockHeight,
      messageId,
      { txCount: 1, betsPlaced: 1 }
    );
  }

  private async handleVaraBetPlaced(
    payload: VaraBetPlacedPayload,
    blockHeight: number,
    blockTimestamp: Date,
    messageId: string
  ): Promise<void> {
    const basketId = basketEntityId(payload.basket_id);
    const user = String(payload.user);
    const position = new ChipPosition({
      id: chipPositionId(basketId, user),
      basketId,
      user,
      userPublicId: getAgentPublicId(user),
      shares: toBigIntValue(payload.user_total),
      indexAtCreationBps: payload.index_at_creation_bps,
      claimed: false,
      updatedAt: blockTimestamp,
    });

    this.chipPositionsToSave.set(position.id, position);
    await this.recordActivity(
      blockTimestamp,
      user,
      blockHeight,
      messageId,
      { txCount: 1, betsPlaced: 1 }
    );
  }

  private async handleBetClaimed(
    payload: BetClaimedPayload,
    blockHeight: number,
    blockTimestamp: Date,
    messageId: string
  ): Promise<void> {
    const basketId = basketEntityId(payload.basket_id);
    const id = chipPositionId(basketId, String(payload.user));
    const existing =
      this.chipPositionsToSave.get(id) ||
      (await this.ctx.store.findOneBy(ChipPosition, { id }));

    if (existing) {
      existing.claimed = true;
      existing.updatedAt = blockTimestamp;
      this.chipPositionsToSave.set(id, existing);
    }

    await this.recordActivity(
      blockTimestamp,
      String(payload.user),
      blockHeight,
      messageId,
      { txCount: 1, claimsCount: 1 }
    );
  }

  private async handleBetTokenApproved(
    payload: BetTokenApprovedPayload,
    blockHeight: number,
    blockTimestamp: Date,
    messageId: string
  ): Promise<void> {
    await this.recordActivity(
      blockTimestamp,
      String(payload.owner),
      blockHeight,
      messageId,
      { txCount: 1, approvesCount: 1 }
    );
  }

  private async handleBetTokenClaimed(
    payload: BetTokenClaimedPayload,
    blockHeight: number,
    blockTimestamp: Date,
    messageId: string
  ): Promise<void> {
    await this.recordActivity(
      blockTimestamp,
      String(payload.user),
      blockHeight,
      messageId,
      { txCount: 1, claimsCount: 1 }
    );
  }

  private async recordActivity(
    txTimestamp: Date,
    user: string,
    blockHeight: number,
    messageId: string,
    deltas: {
      txCount?: number;
      basketsMade?: number;
      betsPlaced?: number;
      approvesCount?: number;
      claimsCount?: number;
    }
  ): Promise<void> {
    const dayId = dayIdFromTimestamp(dateToTimestampMs(txTimestamp));
    const id = dailyUserActivityAggregateId(dayId, user);
    const existing =
      this.activitiesToSave.get(id) ||
      (await this.ctx.store.findOneBy(DailyUserActivityAggregate, { id })) ||
      new DailyUserActivityAggregate({
        id,
        dayId,
        user,
        userPublicId: getAgentPublicId(user),
        txCount: 0,
        basketsMade: 0,
        betsPlaced: 0,
        approvesCount: 0,
        claimsCount: 0,
        firstTxAt: txTimestamp,
        firstTxBlock: BigInt(blockHeight),
        firstTxMessageId: messageId,
        lastTxAt: txTimestamp,
        lastTxBlock: BigInt(blockHeight),
        lastTxMessageId: messageId,
        updatedAt: txTimestamp,
      });

    existing.txCount += deltas.txCount ?? 0;
    existing.basketsMade += deltas.basketsMade ?? 0;
    existing.betsPlaced += deltas.betsPlaced ?? 0;
    existing.approvesCount += deltas.approvesCount ?? 0;
    existing.claimsCount += deltas.claimsCount ?? 0;

    const currentLastTxMs = existing.lastTxAt.getTime();
    const nextTxMs = txTimestamp.getTime();
    const nextBlock = BigInt(blockHeight);
    const currentFirstTxMs = existing.firstTxAt.getTime();
    const shouldReplaceFirstTx =
      nextTxMs < currentFirstTxMs ||
      (nextTxMs === currentFirstTxMs &&
        (nextBlock < existing.firstTxBlock ||
          (nextBlock === existing.firstTxBlock &&
            messageId.localeCompare(existing.firstTxMessageId) < 0)));
    const shouldReplaceLastTx =
      nextTxMs > currentLastTxMs ||
      (nextTxMs === currentLastTxMs &&
        (nextBlock > existing.lastTxBlock ||
          (nextBlock === existing.lastTxBlock &&
            messageId.localeCompare(existing.lastTxMessageId) > 0)));

    if (shouldReplaceFirstTx) {
      existing.firstTxAt = txTimestamp;
      existing.firstTxBlock = nextBlock;
      existing.firstTxMessageId = messageId;
    }

    if (shouldReplaceLastTx) {
      existing.lastTxAt = txTimestamp;
      existing.lastTxBlock = nextBlock;
      existing.lastTxMessageId = messageId;
    }

    existing.updatedAt = txTimestamp;
    this.activitiesToSave.set(id, existing);
    await this.recomputeDay(dayId, txTimestamp);
  }

  private async handleSettlementFinalized(
    payload: SettlementFinalizedPayload,
    _blockHeight: number,
    blockTimestamp: Date
  ): Promise<void> {
    const basketId = basketEntityId(payload.basket_id);
    const basket =
      this.basketsToSave.get(basketId) ||
      (await this.ctx.store.findOneBy(Basket, { id: basketId }));
    const assetKind = payload.asset_kind ?? basket?.assetKind ?? null;

    if (assetKind !== "Vara") {
      return;
    }

    const finalizedAt = timestampMsToDate(payload.finalized_at);
    const finalizedAtMs = dateToTimestampMs(finalizedAt);
    const dayId = dayIdFromTimestamp(finalizedAtMs);
    const payoutPerShare = toBigIntValue(payload.payout_per_share);

    this.basketSettlementsToSave.set(
      basketSettlementId(payload.basket_id),
      new BasketSettlement({
        id: basketSettlementId(payload.basket_id),
        basketId,
        dayId,
        finalizedAt,
        payoutPerShare,
        status: "finalized",
      })
    );

    const persistedPositions = await this.ctx.store.find(ChipPosition, {
      where: { basketId } as FindOptionsWhere<ChipPosition>,
    });
    const positions = new Map(
      persistedPositions.map((position) => [position.id, position])
    );

    for (const [id, position] of this.chipPositionsToSave.entries()) {
      if (position.basketId === basketId) {
        positions.set(id, position);
      }
    }

    for (const position of positions.values()) {
      if (position.shares <= 0n) {
        continue;
      }

      const payout =
        payoutPerShare === 0n
          ? 0n
          : (position.shares * payoutPerShare) / BigInt(position.indexAtCreationBps);

      const contribution = new DailyBasketContribution({
        id: dailyContributionId(dayId, basketId, position.user),
        dayId,
        basketId,
        user: position.user,
        userPublicId: getAgentPublicId(position.user),
        realizedProfit: payout - position.shares,
        payout,
        principal: position.shares,
        finalizedAt,
      });

      this.contributionsToSave.set(contribution.id, contribution);
    }

    await this.recomputeAllTimeBasketStat(basketId, finalizedAt);
    await this.recomputeDay(dayId, blockTimestamp);
  }

  private async recomputeAllTimeBasketStat(
    basketId: string,
    updatedAt: Date
  ): Promise<void> {
    const persisted = await this.ctx.store.find(DailyBasketContribution, {
      where: { basketId } as FindOptionsWhere<DailyBasketContribution>,
    });

    const contributions = new Map(persisted.map((item) => [item.id, item]));
    for (const [id, contribution] of this.contributionsToSave.entries()) {
      if (contribution.basketId === basketId) {
        contributions.set(id, contribution);
      }
    }

    let totalPayout = 0n;
    let totalRealizedProfit = 0n;
    let totalPrincipal = 0n;
    let participantCount = 0;

    for (const contribution of contributions.values()) {
      totalPayout += contribution.payout;
      totalRealizedProfit += contribution.realizedProfit;
      totalPrincipal += contribution.principal;
      participantCount += 1;
    }

    this.allTimeBasketStatsToSave.set(
      basketId,
      new AllTimeBasketStat({
        id: basketId,
        basketId,
        totalPayout: totalPayout.toString(),
        totalRealizedProfit: totalRealizedProfit.toString(),
        totalPrincipal: totalPrincipal.toString(),
        participantCount,
        updatedAt,
      })
    );
  }

  private async recomputeAllTimeAgentBasketStats(
    address: string,
    updatedAt: Date
  ): Promise<void> {
    const persisted = await this.ctx.store.find(Basket, {
      where: { creator: address } as FindOptionsWhere<Basket>,
    });

    const baskets = new Map(persisted.map((basket) => [basket.id, basket]));
    for (const [id, basket] of this.basketsToSave.entries()) {
      if (basket.creator.toLowerCase() === address.toLowerCase()) {
        baskets.set(id, basket);
      }
    }

    const betBaskets = [...baskets.values()]
      .filter((basket) => basket.assetKind.toLowerCase() === "vara")
      .sort((left, right) => left.basketId.localeCompare(right.basketId));

    const normalizedAddress = address.toLowerCase();
    const existing =
      this.allTimeAgentStatsToSave.get(normalizedAddress) ||
      (await this.ctx.store.findOneBy(AllTimeAgentStat, { id: normalizedAddress }));

    this.allTimeAgentStatsToSave.set(
      normalizedAddress,
      new AllTimeAgentStat({
        id: normalizedAddress,
        address,
        publicId: betBaskets[0]?.creatorPublicId ?? existing?.publicId ?? getAgentPublicId(address),
        basketCount: betBaskets.length,
        totalRewards: existing?.totalRewards ?? "0",
        basketIds: betBaskets.map((basket) => basket.id),
        updatedAt,
      })
    );
  }

  private async recomputeAllTimeAgentRewards(
    address: string,
    updatedAt: Date
  ): Promise<void> {
    const persisted = await this.ctx.store.find(ContestDayWinner, {
      where: { user: address } as FindOptionsWhere<ContestDayWinner>,
    });

    const winners = new Map(persisted.map((winner) => [winner.id, winner]));
    for (const entries of this.winnersByDay.values()) {
      for (const winner of entries) {
        if (winner.user.toLowerCase() === address.toLowerCase()) {
          winners.set(winner.id, winner);
        }
      }
    }

    let totalRewards = 0n;
    let publicId = getAgentPublicId(address);
    for (const winner of winners.values()) {
      totalRewards += winner.reward ?? 0n;
      publicId = winner.userPublicId || publicId;
    }

    const normalizedAddress = address.toLowerCase();
    const existing =
      this.allTimeAgentStatsToSave.get(normalizedAddress) ||
      (await this.ctx.store.findOneBy(AllTimeAgentStat, { id: normalizedAddress }));

    this.allTimeAgentStatsToSave.set(
      normalizedAddress,
      new AllTimeAgentStat({
        id: normalizedAddress,
        address,
        publicId: existing?.publicId ?? publicId,
        basketCount: existing?.basketCount ?? 0,
        totalRewards: totalRewards.toString(),
        basketIds: existing?.basketIds ?? [],
        updatedAt,
      })
    );
  }

  private async recomputeDay(dayId: bigint, blockTimestamp: Date): Promise<void> {
    const persistedContributions = await this.ctx.store.find(DailyBasketContribution, {
      where: { dayId } as FindOptionsWhere<DailyBasketContribution>,
    });

    const contributions = new Map(
      persistedContributions.map((item) => [item.id, item])
    );

    for (const [id, contribution] of this.contributionsToSave.entries()) {
      if (contribution.dayId === dayId) {
        contributions.set(id, contribution);
      }
    }

    const perUser = new Map<
      string,
      { realizedProfit: bigint; basketIds: Set<string> }
    >();

    for (const contribution of contributions.values()) {
      const current = perUser.get(contribution.user) ?? {
        realizedProfit: 0n,
        basketIds: new Set<string>(),
      };

      current.realizedProfit += contribution.realizedProfit;
      current.basketIds.add(contribution.basketId);
      perUser.set(contribution.user, current);
    }

    const aggregates = [...perUser.entries()].map(
      ([user, value]) =>
        new DailyUserAggregate({
          id: dailyUserAggregateId(dayId, user),
          dayId,
          user,
          userPublicId: getAgentPublicId(user),
          realizedProfit: value.realizedProfit,
          basketCount: value.basketIds.size,
          updatedAt: blockTimestamp,
        })
    );

    this.aggregateDaysToReplace.add(dayId.toString());
    this.aggregatesByDay.set(dayId.toString(), aggregates);

    const persistedActivities = await this.ctx.store.find(DailyUserActivityAggregate, {
      where: { dayId } as FindOptionsWhere<DailyUserActivityAggregate>,
    });
    const activities = new Map(
      persistedActivities.map((item) => [item.id, item])
    );

    for (const [id, activity] of this.activitiesToSave.entries()) {
      if (activity.dayId === dayId) {
        activities.set(id, activity);
      }
    }

    const profitsByUser = new Map(
      aggregates.map((aggregate) => [aggregate.user, aggregate.realizedProfit])
    );

    const ranked = sortedWinners(
      Array.from(activities.values()).map((activity) => ({
        user: activity.user,
        txCount: activity.txCount,
        realizedProfit: profitsByUser.get(activity.user) ?? 0n,
        firstTxAt: activity.firstTxAt,
        firstTxBlock: activity.firstTxBlock,
        firstTxMessageId: activity.firstTxMessageId,
        lastTxAt: activity.lastTxAt,
        lastTxBlock: activity.lastTxBlock,
        lastTxMessageId: activity.lastTxMessageId,
        dayId,
      }))
    );

    const winners = ranked.slice(0, MAX_DAILY_WINNERS).map(
      (winner, index) =>
        new ContestDayWinner({
          id: contestWinnerId(dayId, winner.user),
          dayId: contestDayId(dayId),
          user: winner.user,
          userPublicId: getAgentPublicId(winner.user),
          rank: index + 1,
          realizedProfit: winner.realizedProfit,
          reward: null,
        })
    );

    this.winnerDaysToReplace.add(dayId.toString());
    this.winnersByDay.set(dayId.toString(), winners);

    const existingDay =
      this.daysToSave.get(contestDayId(dayId)) ||
      (await this.ctx.store.findOneBy(ContestDayProjection, {
        id: contestDayId(dayId),
      }));

    const maxRealizedProfit = winners.length ? winners[0].realizedProfit : null;

    this.daysToSave.set(
      contestDayId(dayId),
      new ContestDayProjection({
        id: contestDayId(dayId),
        dayId,
        status: winners.length ? "ready" : "no_winner",
        maxRealizedProfit,
        winnerCount: winners.length,
        totalReward: existingDay?.totalReward ?? null,
        settledOnChain: existingDay?.settledOnChain ?? false,
        indexerComplete: computeIndexerComplete(
          dayId,
          this.indexerState?.lastProcessedAt ?? null,
          this.indexerState?.knownGapDetected ?? false
        ),
        settlementAllowedAt: settlementAllowedAtDate(dayId),
        settledAt: existingDay?.settledAt ?? null,
        resultHash: existingDay?.resultHash ?? null,
        evidenceHash: existingDay?.evidenceHash ?? null,
        updatedAt: blockTimestamp,
      })
    );
  }

  private async handleDaySettled(payload: DaySettledPayload): Promise<void> {
    const dayId = toBigIntValue(payload.day_id);
    const dayKey = dayId.toString();
    this.winnerDaysToReplace.add(dayKey);
    if (payload.winner_count === 0) {
      this.winnersByDay.set(dayKey, []);
    }

    const existing =
      this.daysToSave.get(contestDayId(dayId)) ||
      (await this.ctx.store.findOneBy(ContestDayProjection, {
        id: contestDayId(dayId),
      }));

    this.daysToSave.set(
      contestDayId(dayId),
      new ContestDayProjection({
        id: contestDayId(dayId),
        dayId,
        status: payload.winner_count > 0 ? "settled" : "no_winner",
        maxRealizedProfit: existing?.maxRealizedProfit ?? null,
        winnerCount: payload.winner_count,
        totalReward: toBigIntValue(payload.total_reward),
        settledOnChain: true,
        indexerComplete: computeIndexerComplete(
          dayId,
          this.indexerState?.lastProcessedAt ?? null,
          this.indexerState?.knownGapDetected ?? false
        ),
        settlementAllowedAt: settlementAllowedAtDate(dayId),
        settledAt: timestampMsToDate(payload.settled_at),
        resultHash: hexValue(payload.result_hash),
        evidenceHash: hexValue(payload.evidence_hash),
        updatedAt: timestampMsToDate(payload.settled_at),
      })
    );
  }

  private async handleWinnersPaid(payload: WinnersPaidPayload): Promise<void> {
    const dayId = toBigIntValue(payload.day_id);
    const dayKey = dayId.toString();
    this.winnerDaysToReplace.add(dayKey);

    const winners = payload.payouts.map(
      (payout, index) =>
        new ContestDayWinner({
          id: contestWinnerId(dayId, String(payout.account)),
          dayId: contestDayId(dayId),
          user: String(payout.account),
          userPublicId: getAgentPublicId(String(payout.account)),
          rank: index + 1,
          realizedProfit: toBigIntValue(payout.realized_profit),
          reward: toBigIntValue(payout.reward),
        })
    );
    this.winnersByDay.set(dayKey, winners);
    for (const winner of winners) {
      await this.recomputeAllTimeAgentRewards(winner.user, new Date());
    }

    const existingDay =
      this.daysToSave.get(contestDayId(dayId)) ||
      (await this.ctx.store.findOneBy(ContestDayProjection, {
        id: contestDayId(dayId),
      }));

    if (!existingDay) {
      this.daysToSave.set(
        contestDayId(dayId),
        new ContestDayProjection({
          id: contestDayId(dayId),
          dayId,
          status: "settled",
          maxRealizedProfit: winners[0]?.realizedProfit ?? null,
          winnerCount: winners.length,
          totalReward: null,
          settledOnChain: true,
          indexerComplete: computeIndexerComplete(
            dayId,
            this.indexerState?.lastProcessedAt ?? null,
            this.indexerState?.knownGapDetected ?? false
          ),
          settlementAllowedAt: settlementAllowedAtDate(dayId),
          settledAt: null,
          resultHash: null,
          evidenceHash: null,
          updatedAt: new Date(),
        })
      );
    }
  }

  private async advanceIndexerHead(
    blockHeight: bigint,
    blockTimestamp: Date
  ): Promise<void> {
    if (!this.indexerState) {
      return;
    }

    this.indexerState.lastProcessedBlock = blockHeight;
    this.indexerState.lastProcessedAt = blockTimestamp;

    if (this.indexerState.startDayId === null) {
      this.indexerState.startDayId = dayIdFromTimestamp(dateToTimestampMs(blockTimestamp));
    }

    this.indexerState.updatedAt = new Date();

    const latestCompleteDayId = maxCompleteDayId(dateToTimestampMs(blockTimestamp));
    if (latestCompleteDayId === null) {
      return;
    }

    const startDayId = this.indexerState.startDayId;
    if (startDayId === null || latestCompleteDayId < startDayId) {
      return;
    }

    for (let dayId = startDayId; dayId <= latestCompleteDayId; dayId += 1n) {
      const existing =
        this.daysToSave.get(contestDayId(dayId)) ||
        (await this.ctx.store.findOneBy(ContestDayProjection, {
          id: contestDayId(dayId),
        }));

      if (!existing && emptyDayPolicy === "settle_no_winner") {
        this.daysToSave.set(
          contestDayId(dayId),
          new ContestDayProjection({
            id: contestDayId(dayId),
            dayId,
            status: "no_winner",
            maxRealizedProfit: null,
            winnerCount: 0,
            totalReward: null,
            settledOnChain: false,
            indexerComplete: !this.indexerState.knownGapDetected,
            settlementAllowedAt: settlementAllowedAtDate(dayId),
            settledAt: null,
            resultHash: null,
            evidenceHash: null,
            updatedAt: blockTimestamp,
          })
        );
        continue;
      }

      if (existing) {
        existing.indexerComplete = !this.indexerState.knownGapDetected;
        existing.settlementAllowedAt = settlementAllowedAtDate(dayId);
        existing.updatedAt = blockTimestamp;
        this.daysToSave.set(existing.id, existing);
      }
    }

    this.indexerState.lastMaterializedDayId = latestCompleteDayId;
  }
}
