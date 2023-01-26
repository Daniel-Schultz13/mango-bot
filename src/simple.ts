import * as os from 'os';
import * as fs from 'fs';
import {
  Config,
  getMarketByBaseSymbolAndKind,
  getUnixTs,
  IDS,
  Cluster,
  PublicKey,
  GroupConfig,
  MangoClient,
  ZERO_BN,
} from '@blockworks-foundation/mango-client';
import { Keypair, Commitment, Connection } from '@solana/web3.js';
import { Market } from '@project-serum/serum';
import path from 'path';

const paramsFileName = process.env.PARAMS || 'devnet.json';
const params = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, `../params/${paramsFileName}`),
    'utf-8',
  ),
);

function readKeypair() {
  return JSON.parse(
    process.env.KEYPAIR ||
      fs.readFileSync(os.homedir() + '/.config/solana/id.json', 'utf-8'),
  );
}

async function exampleSpot() {
  // setup client
  const config = new Config(IDS);
  const groupConfig = config.getGroupWithName(params.group) as GroupConfig;
  if (!groupConfig) {
    throw new Error(`Group ${params.group} not found`);
  }
  const cluster = groupConfig.cluster as Cluster;
  const connection = new Connection(
    process.env.ENDPOINT_URL || config.cluster_urls[cluster],
    'processed' as Commitment,
  );
  const client = new MangoClient(connection, groupConfig.mangoProgramId);

  // load group & market
  const spotMarketConfig = getMarketByBaseSymbolAndKind(
    groupConfig,
    'BTC',
    'spot',
  );
  const mangoGroup = await client.getMangoGroup(groupConfig.publicKey);
  const spotMarket = await Market.load(
    connection,
    spotMarketConfig.publicKey,
    undefined,
    groupConfig.serumProgramId,
  );

  // Fetch orderbooks
  let bids = await spotMarket.loadBids(connection);
  let asks = await spotMarket.loadAsks(connection);

  // L2 orderbook data
  for (const [price, size] of bids.getL2(20)) {
    console.log(price, size);
  }

  // L3 orderbook data
  for (const order of asks) {
    console.log(
      order.openOrdersAddress.toBase58(),
      order.orderId.toString('hex'),
      order.price,
      order.size,
      order.side, // 'buy' or 'sell'
    );
  }

  // Place order
  const owner = Keypair.fromSecretKey(Uint8Array.from(readKeypair()));
  const mangoAccount = (
    await client.getMangoAccountsForDelegate(mangoGroup, owner.publicKey, true)
  )[0];
  await client.placeSpotOrder2(
    mangoGroup,
    mangoAccount,
    spotMarket,
    owner,
    'buy', // or 'sell'
    41000,
    0.0001,
    'limit',
    ZERO_BN, // client order id, set to whatever you want
    true, // use the mango MSRM vault for fee discount
  ); // or 'ioc' or 'postOnly'

  // Reload bids and asks and find your open orders
  // Possibly have a wait here so RPC node can catch up
  const openOrders = await mangoAccount.loadSpotOrdersForMarket(
    connection,
    spotMarket,
    spotMarketConfig.marketIndex,
  );

  // cancel orders
  for (const order of openOrders) {
    await client.cancelSpotOrder(
      mangoGroup,
      mangoAccount,
      owner,
      spotMarket,
      order,
    );
  }

  // Retrieve fills
  for (const fill of await spotMarket.loadFills(connection)) {
    console.log(
      fill.openOrders.toBase58(),
      fill.eventFlags.maker ? 'maker' : 'taker',
      fill.size * (fill.side === 'buy' ? 1 : -1),
      spotMarket.quoteSplSizeToNumber(
        fill.side === 'buy'
          ? fill.nativeQuantityPaid
          : fill.nativeQuantityReleased,
      ),
    );
  }

  // Settle funds
  for (const openOrders of await mangoAccount.loadOpenOrders(
    connection,
    groupConfig.serumProgramId,
  )) {
    if (!openOrders) continue;

    if (
      openOrders.baseTokenFree.gt(ZERO_BN) ||
      openOrders.quoteTokenFree.gt(ZERO_BN)
    ) {
      await client.settleFunds(mangoGroup, mangoAccount, owner, spotMarket);
    }
  }
}

exampleSpot();
