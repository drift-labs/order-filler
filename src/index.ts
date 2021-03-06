import { BN, Provider } from '@project-serum/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

import {
	bulkPollingUserSubscribe,
	BulkAccountLoader,
	ClearingHouse,
	initialize,
	ClearingHouseUser,
	isVariant,
	Markets,
	UserOrdersAccount,
	OrderRecord,
	getUserOrdersAccountPublicKey,
	calculateMarkPrice,
	convertToNumber,
	MARK_PRICE_PRECISION,
	TEN_THOUSAND,
	isOrderRiskIncreasing,
	Wallet,
	getClearingHouse,
	getPollingClearingHouseConfig,
	getClearingHouseUser,
	getPollingClearingHouseUserConfig,
	QUOTE_PRECISION,
	ZERO,
	calculateBaseAssetAmountMarketCanExecute,
	calculateBaseAssetAmountUserCanExecute,
	isOrderReduceOnly,
	OracleSubscriber,
	getOracleClient,
	PollingOracleSubscriber,
	calculateAskPrice,
	calculateBidPrice,
	calculateOracleSpread,
	isOracleValid,
} from '@drift-labs/sdk';

import { Node, OrderList } from './dlob/OrderList';
import { CloudWatchClient } from './cloudWatchClient';
import { getErrorCode } from './error';
import { DLOB, DLOBOrderLists } from './dlob/DLOB';

require('dotenv').config();
//@ts-ignore
const sdkConfig = initialize({ env: process.env.ENV });

const cloudWatchClient = new CloudWatchClient(
	sdkConfig.ENV === 'mainnet-beta' ? 'eu-west-1' : 'us-east-1',
	process.env.ENABLE_CLOUDWATCH === 'true'
);

export function getWallet(): Wallet {
	const privateKey = process.env.FILLER_PRIVATE_KEY;
	const keypair = Keypair.fromSecretKey(
		Uint8Array.from(privateKey.split(',').map((val) => Number(val)))
	);
	return new Wallet(keypair);
}

const endpoint = process.env.ENDPOINT;
const connection = new Connection(endpoint);

const wallet = getWallet();
const provider = new Provider(connection, wallet, Provider.defaultOptions());
const clearingHousePublicKey = new PublicKey(
	sdkConfig.CLEARING_HOUSE_PROGRAM_ID
);

const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 500);
const clearingHouse = getClearingHouse(
	getPollingClearingHouseConfig(
		connection,
		provider.wallet,
		clearingHousePublicKey,
		bulkAccountLoader
	)
);

const intervalIds = [];
const runBot = async (wallet: Wallet, clearingHouse: ClearingHouse) => {
	const lamportsBalance = await connection.getBalance(wallet.publicKey);
	console.log('SOL balance:', lamportsBalance / 10 ** 9);
	await clearingHouse.subscribe(['orderHistoryAccount']);
	clearingHouse.eventEmitter.on('error', (e) => {
		console.log('clearing house error');
		console.error(e);
	});

	console.log(clearingHouse.program.programId.toString());

	let markets = clearingHouse
		.getMarketsAccount()
		.markets.filter((market) => market.initialized);
	const updateMarkets = () => {
		markets = clearingHouse
			.getMarketsAccount()
			.markets.filter((market) => market.initialized);
	};
	const updateMarketsIntervalId = setInterval(updateMarkets, 15 * 60 * 1000); // every 15 minutes
	intervalIds.push(updateMarketsIntervalId);

	const dlob = new DLOB();
	const oracleSubscribers = new Map<string, OracleSubscriber>();
	for (const market of markets) {
		const oracleClient = getOracleClient(
			market.amm.oracleSource,
			connection,
			sdkConfig.ENV
		);
		const publicKey = market.amm.oracle;
		const oracleSubscriber = new PollingOracleSubscriber(
			publicKey,
			oracleClient,
			bulkAccountLoader
		);
		await oracleSubscriber.subscribe();
		oracleSubscribers.set(publicKey.toString(), oracleSubscriber);
	}

	// explicitly grab order index before we initially build order list
	// so we're less likely to have missed records while we fetch order accounts
	let nextOrderHistoryIndex = clearingHouse
		.getOrderHistoryAccount()
		.head.toNumber();

	const programAccounts = await clearingHouse.program.account.userOrders.all();
	for (const programAccount of programAccounts) {
		const userOrderAccountPublicKey = programAccount.publicKey;
		// @ts-ignore
		const userOrdersAccount: UserOrdersAccount = programAccount.account;
		const userAccountPublicKey = userOrdersAccount.user;

		for (const order of userOrdersAccount.orders) {
			dlob.insert(order, userAccountPublicKey, userOrderAccountPublicKey);
		}
	}
	console.log('initial number of orders', dlob.openOrders.size);

	const printTopOfOrderLists = (dlobOrderLists: DLOBOrderLists) => {
		const marketIndex = dlobOrderLists.fixed.ask.asc.marketIndex;
		const market = clearingHouse.getMarket(marketIndex);
		const oraclePriceData = oracleSubscribers
			.get(market.amm.oracle.toString())
			.getOraclePriceData();
		const askPrice = calculateAskPrice(market);
		const markPrice = calculateMarkPrice(market);
		const bidPrice = calculateBidPrice(market);

		const askOracleSpread = calculateOracleSpread(askPrice, oraclePriceData);
		const markOracleSpread = calculateOracleSpread(markPrice, oraclePriceData);
		const bidOracleSpread = calculateOracleSpread(bidPrice, oraclePriceData);

		console.log(`Market ${Markets[marketIndex.toNumber()].symbol} Orders`);
		console.log(
			`Ask`,
			convertToNumber(askPrice, MARK_PRICE_PRECISION).toFixed(3)
		);
		dlobOrderLists.fixed.bid.desc.printTop();
		dlobOrderLists.fixed.mark.desc.printTop();
		console.log(
			`Mark`,
			convertToNumber(markPrice, MARK_PRICE_PRECISION).toFixed(3)
		);
		dlobOrderLists.fixed.mark.asc.printTop();
		dlobOrderLists.fixed.ask.asc.printTop();
		console.log(
			`Bid`,
			convertToNumber(bidPrice, MARK_PRICE_PRECISION).toFixed(3)
		);

		console.log(
			`Ask Oracle Spread`,
			convertToNumber(askOracleSpread, MARK_PRICE_PRECISION).toFixed(3)
		);
		dlobOrderLists.floating.bid.desc.printTop();
		dlobOrderLists.floating.mark.desc.printTop();
		console.log(
			`Mark Oracle Spread`,
			convertToNumber(markOracleSpread, MARK_PRICE_PRECISION).toFixed(3)
		);
		dlobOrderLists.floating.mark.asc.printTop();
		dlobOrderLists.floating.ask.asc.printTop();
		console.log(
			`Bid Oracle Spread`,
			convertToNumber(bidOracleSpread, MARK_PRICE_PRECISION).toFixed(3)
		);
	};

	const printOrderLists = () => {
		for (const [_, orderLists] of dlob.orderLists) {
			printTopOfOrderLists(orderLists);
		}
	};
	printOrderLists();

	const sleep = (ms: number) => {
		return new Promise((resolve) => {
			setTimeout(resolve, ms);
		});
	};

	const updateUserOrders = (
		user: ClearingHouseUser,
		userAccountPublicKey: PublicKey,
		userOrdersAccountPublicKey: PublicKey
	): BN => {
		const marginRatio = user.getMarginRatio();
		const tooMuchLeverage = user.getFreeCollateral().eq(ZERO);

		if (user.getUserOrdersAccount()) {
			for (const order of user.getUserOrdersAccount().orders) {
				const orderIsRiskIncreasing = isOrderRiskIncreasing(user, order);
				const orderIsReduceOnly = isOrderReduceOnly(user, order);

				if (tooMuchLeverage && orderIsRiskIncreasing) {
					dlob.disable(order, () => {
						console.log(
							`User has too much leverage and order is risk increasing. Disabling order ${order.orderId.toString()}`
						);
						printTopOfOrderLists(
							dlob.orderLists.get(order.marketIndex.toNumber())
						);
					});
				} else if (!orderIsReduceOnly && order.reduceOnly) {
					dlob.disable(order, () => {
						console.log(
							`Order ${order.orderId.toString()} is risk increasing but reduce only. Disabling`
						);
						printTopOfOrderLists(
							dlob.orderLists.get(order.marketIndex.toNumber())
						);
					});
				} else if (user.getUserAccount().collateral.eq(ZERO)) {
					dlob.disable(order, () => {
						console.log(
							`Disabling order ${order.orderId.toString()} as authority ${user.authority.toString()} has no collateral`
						);
						printTopOfOrderLists(
							dlob.orderLists.get(order.marketIndex.toNumber())
						);
					});
				} else {
					dlob.enable(
						order,
						userAccountPublicKey,
						userOrdersAccountPublicKey,
						() => {
							console.log(`Enabling order ${order.orderId.toString()}`);
							printTopOfOrderLists(
								dlob.orderLists.get(order.marketIndex.toNumber())
							);
						}
					);
				}
			}
		}
		return marginRatio;
	};

	let lastUserUpdate = Date.now();
	const processUser = async (user: ClearingHouseUser) => {
		const userAccountPublicKey = await user.getUserAccountPublicKey();
		const userOrdersAccountPublicKey =
			await user.getUserOrdersAccountPublicKey();

		user.eventEmitter.on('userPositionsData', () => {
			lastUserUpdate = Date.now();
			updateUserOrders(user, userAccountPublicKey, userOrdersAccountPublicKey);
			userMap.set(userAccountPublicKey.toString(), { user, upToDate: true });
		});

		// eslint-disable-next-line no-constant-condition
		while (true) {
			const marginRatio = updateUserOrders(
				user,
				userAccountPublicKey,
				userOrdersAccountPublicKey
			);
			const marginRatioNumber = convertToNumber(marginRatio, TEN_THOUSAND);
			const oneMinute = 1000 * 60;
			const sleepTime = Math.min(
				Math.round(marginRatioNumber * 100) ** 2,
				oneMinute
			);
			await sleep(sleepTime);
		}
	};

	const userAccountLoader = new BulkAccountLoader(
		connection,
		'processed',
		5000
	);

	const checkLastUserUpdate = () => {
		const time = Date.now();
		const tenMinutes = 10 * 60 * 1000;
		if (time - lastUserUpdate > tenMinutes) {
			cloudWatchClient.logNoUserUpdate();
		}
	};
	const checkLastUserUpdateIntervalId = setInterval(
		checkLastUserUpdate,
		60 * 1000
	);
	intervalIds.push(checkLastUserUpdateIntervalId);

	const userMap = new Map<
		string,
		{ user: ClearingHouseUser; upToDate: boolean }
	>();
	const fetchAllUsers = async () => {
		const programUserAccounts =
			(await clearingHouse.program.account.user.all()) as any[];
		const userArray: ClearingHouseUser[] = [];
		for (const programUserAccount of programUserAccounts) {
			const userAccountPubkey = programUserAccount.publicKey.toString();

			// if the user has less than one dollar in account, disregard initially
			// if an order comes from this user, we can add them then.
			// This makes it so that we don't need to listen to inactive users
			if (programUserAccount.account.collateral.lt(QUOTE_PRECISION)) {
				continue;
			}

			if (userMap.has(userAccountPubkey)) {
				continue;
			}
			const user = getClearingHouseUser(
				getPollingClearingHouseUserConfig(
					clearingHouse,
					programUserAccount.account.authority,
					userAccountLoader
				)
			);
			userArray.push(user);
		}

		await bulkPollingUserSubscribe(userArray, userAccountLoader);
		for (const user of userArray) {
			const userAccountPubkey = await user.getUserAccountPublicKey();
			userMap.set(userAccountPubkey.toString(), { user, upToDate: true });
			processUser(user);
		}
	};
	await fetchAllUsers();

	let updateOrderListMutex = 0;
	const handleOrderRecord = async (record: OrderRecord) => {
		const order = record.order;
		// Disregard market orders
		if (isVariant(order.orderType, 'market')) {
			return;
		}

		if (isVariant(record.action, 'place')) {
			const userOrdersAccountPublicKey = await getUserOrdersAccountPublicKey(
				clearingHouse.program.programId,
				record.user
			);
			dlob.insert(order, record.user, userOrdersAccountPublicKey, () => {
				console.log(`Order ${order.orderId.toString()} placed. Added to dlob`);
			});
		} else if (isVariant(record.action, 'cancel')) {
			dlob.remove(order, () => {
				console.log(
					`Order ${order.orderId.toString()} canceled. Removed from dlob`
				);
			});
		} else if (isVariant(record.action, 'expire')) {
			dlob.remove(order, () => {
				console.log(
					`Order ${order.orderId.toString()} expired. Removed from dlob`
				);
			});
		} else if (isVariant(record.action, 'fill')) {
			if (order.baseAssetAmount.eq(order.baseAssetAmountFilled)) {
				dlob.remove(order, () => {
					console.log(
						`Order ${order.orderId.toString()} completely filled. Removed from dlob`
					);
				});
			} else {
				dlob.update(order, () => {
					console.log(
						`Order ${order.orderId.toString()} partially filled. Updated dlob`
					);
				});
			}
		}

		printTopOfOrderLists(dlob.orderLists.get(order.marketIndex.toNumber()));
	};

	let lastOrderUpdate = Date.now();
	const updateOrderList = async () => {
		if (updateOrderListMutex === 1) {
			return;
		}
		updateOrderListMutex = 1;
		lastOrderUpdate = Date.now();

		try {
			let head = clearingHouse.getOrderHistoryAccount().head.toNumber();
			const orderHistoryLength =
				clearingHouse.getOrderHistoryAccount().orderRecords.length;
			while (nextOrderHistoryIndex !== head) {
				const nextRecord =
					clearingHouse.getOrderHistoryAccount().orderRecords[
						nextOrderHistoryIndex
					];
				await handleOrderRecord(nextRecord);
				nextOrderHistoryIndex =
					(nextOrderHistoryIndex + 1) % orderHistoryLength;
				head = clearingHouse.getOrderHistoryAccount().head.toNumber();
			}
		} catch (e) {
			console.log(`Unexpected error in update order list`);
			console.error(e);
		} finally {
			updateOrderListMutex = 0;
		}
	};
	clearingHouse.eventEmitter.on('orderHistoryAccountUpdate', updateOrderList);
	await updateOrderList();

	const checkLastOrderHistoryUpdate = () => {
		const time = Date.now();
		const thirtyMinutes = 30 * 60 * 1000;
		if (time - lastOrderUpdate > thirtyMinutes) {
			cloudWatchClient.logNoOrderUpdate();
		}
	};
	const checkLastOrderHistoryUpdateIntervalId = setInterval(
		checkLastOrderHistoryUpdate,
		60 * 1000
	);
	intervalIds.push(checkLastOrderHistoryUpdateIntervalId);

	const fetchUserAndAddToUserMap = async (userAccountPublicKey: PublicKey) => {
		const userAccount = (await clearingHouse.program.account.user.fetch(
			userAccountPublicKey
		)) as any;
		const user = getClearingHouseUser(
			getPollingClearingHouseUserConfig(
				clearingHouse,
				userAccount.authority,
				userAccountLoader
			)
		);
		await user.subscribe();
		processUser(user);
		const mapValue = { user, upToDate: true };
		userMap.set(userAccountPublicKey.toString(), mapValue);
		return mapValue;
	};

	const findNodesToFillFromOrderList = async (
		orderList: OrderList,
		price: BN
	): Promise<Node[]> => {
		if (orderList.head && orderList.head.pricesCross(price)) {
			return await findNodesToFill(orderList.head, price);
		}
		return [];
	};

	const findNodesToFill = async (
		node: Node,
		markPrice: BN
	): Promise<Node[]> => {
		const nodesToFill = [];
		let currentNode = node;
		while (currentNode !== undefined) {
			if (!currentNode.pricesCross(markPrice)) {
				currentNode = undefined;
				break;
			}

			const order = node.order;
			if (order.postOnly && !order.oraclePriceOffset.eq(ZERO)) {
				if (isVariant(order.direction, 'long') && markPrice.gte(order.price)) {
					currentNode = currentNode.next;
					continue;
				}

				if (isVariant(order.direction, 'short') && markPrice.lte(order.price)) {
					currentNode = currentNode.next;
					continue;
				}
			}

			let mapValue = userMap.get(node.userAccount.toString());
			if (!mapValue) {
				console.log(
					`User not found in user map ${node.userAccount.toString()}. Adding before filling.`
				);
				mapValue = await fetchUserAndAddToUserMap(node.userAccount);
			}
			const { upToDate: userUpToDate } = mapValue;
			if (!currentNode.haveFilled && userUpToDate) {
				nodesToFill.push(currentNode);
			}

			currentNode = currentNode.next;
		}

		return nodesToFill;
	};

	const perMarketMutex = Array(64).fill(0);
	const tryFillForMarket = async (marketIndex: BN) => {
		if (perMarketMutex[marketIndex.toNumber()] === 1) {
			return;
		}
		perMarketMutex[marketIndex.toNumber()] = 1;

		try {
			const market = clearingHouse.getMarket(marketIndex);
			const fixedOrderLists = dlob.getOrderLists(
				marketIndex.toNumber(),
				'fixed'
			);
			const askPrice = calculateAskPrice(market);
			const markPrice = calculateMarkPrice(market);
			const bidPrice = calculateBidPrice(market);

			const nodesToFill: Node[] = [];
			nodesToFill.push(
				...(await findNodesToFillFromOrderList(
					fixedOrderLists.bid.desc,
					askPrice
				))
			);
			nodesToFill.push(
				...(await findNodesToFillFromOrderList(
					fixedOrderLists.ask.asc,
					bidPrice
				))
			);
			nodesToFill.push(
				...(await findNodesToFillFromOrderList(
					fixedOrderLists.mark.desc,
					markPrice
				))
			);
			nodesToFill.push(
				...(await findNodesToFillFromOrderList(
					fixedOrderLists.mark.asc,
					markPrice
				))
			);

			const floatingOrderLists = dlob.getOrderLists(
				marketIndex.toNumber(),
				'floating'
			);

			const oraclePriceData = oracleSubscribers
				.get(market.amm.oracle.toString())
				.getOraclePriceData();

			const oracleIsValid = isOracleValid(
				market.amm,
				oraclePriceData,
				clearingHouse.getStateAccount().oracleGuardRails,
				bulkAccountLoader.mostRecentSlot
			);

			if (oracleIsValid) {
				const askOracleSpread = calculateOracleSpread(
					askPrice,
					oraclePriceData
				);
				const markOracleSpread = calculateOracleSpread(
					markPrice,
					oraclePriceData
				);
				const bidOracleSpread = calculateOracleSpread(
					bidPrice,
					oraclePriceData
				);

				nodesToFill.push(
					...(await findNodesToFillFromOrderList(
						floatingOrderLists.bid.desc,
						askOracleSpread
					))
				);
				nodesToFill.push(
					...(await findNodesToFillFromOrderList(
						floatingOrderLists.ask.asc,
						bidOracleSpread
					))
				);
				nodesToFill.push(
					...(await findNodesToFillFromOrderList(
						floatingOrderLists.mark.desc,
						markOracleSpread
					))
				);
				nodesToFill.push(
					...(await findNodesToFillFromOrderList(
						floatingOrderLists.mark.asc,
						markOracleSpread
					))
				);
			} else {
				console.log(`Oracle invalid for market ${marketIndex.toString()}`);
			}

			const unfilledNodes = nodesToFill.filter(
				(nodeToFill) => !nodeToFill.haveFilled
			);
			for (const nodeToFill of unfilledNodes) {
				let mapValue = userMap.get(nodeToFill.userAccount.toString());
				if (!mapValue) {
					console.log(
						`User not found in user map ${nodeToFill.userAccount.toString()}. Adding`
					);
					mapValue = await fetchUserAndAddToUserMap(nodeToFill.userAccount);
					continue;
				}
				const { user } = mapValue;

				if (
					isVariant(nodeToFill.order.orderType, 'limit') ||
					isVariant(nodeToFill.order.orderType, 'triggerLimit')
				) {
					const baseAssetAmountMarketCanExecute =
						calculateBaseAssetAmountMarketCanExecute(
							market,
							nodeToFill.order,
							oraclePriceData
						);
					const baseAssetAmountUserCanExecute =
						calculateBaseAssetAmountUserCanExecute(
							market,
							nodeToFill.order,
							user
						);

					if (
						baseAssetAmountMarketCanExecute.lt(
							market.amm.minimumBaseAssetTradeSize
						) ||
						baseAssetAmountUserCanExecute.lt(
							market.amm.minimumBaseAssetTradeSize
						)
					) {
						continue;
					}
				}

				userMap.set(nodeToFill.userAccount.toString(), {
					user,
					upToDate: false,
				});
				nodeToFill.haveFilled = true;

				console.log(
					`trying to fill (account: ${nodeToFill.userAccount.toString()}) order ${nodeToFill.order.orderId.toString()}`
				);
				clearingHouse
					.fillOrder(
						nodeToFill.userAccount,
						nodeToFill.userOrdersAccount,
						nodeToFill.order
					)
					.then((txSig) => {
						console.log(
							`Filled user (account: ${nodeToFill.userAccount.toString()}) order: ${nodeToFill.order.orderId.toString()}`
						);
						console.log(`Tx: ${txSig}`);
					})
					.catch((error) => {
						nodeToFill.haveFilled = false;
						userMap.set(nodeToFill.userAccount.toString(), {
							user,
							upToDate: true,
						});
						console.log(
							`Error filling user (account: ${nodeToFill.userAccount.toString()}) order: ${nodeToFill.order.orderId.toString()}`
						);

						// If we get an error that order does not exist, assume its been filled by somebody else and we
						// have received the history record yet
						const errorCode = getErrorCode(error);
						if (errorCode === 6043) {
							// try to fetch user orders account to make sure its up to date
							user.fetchAccounts();
							dlob.remove(nodeToFill.order, () => {
								console.log(
									`Order ${nodeToFill.order.orderId.toString()} not found when trying to fill. Removing from order list`
								);
							});
							printTopOfOrderLists(
								dlob.orderLists.get(nodeToFill.order.marketIndex.toNumber())
							);
						}
					});
			}
		} catch (e) {
			console.log(`Unexpected error for market ${marketIndex.toString()}`);
			console.error(e);
		} finally {
			perMarketMutex[marketIndex.toNumber()] = 0;
		}
	};

	const tryFill = () => {
		for (const marketIndex in markets) {
			tryFillForMarket(new BN(marketIndex));
		}
	};

	tryFill();
	const handleFillIntervalId = setInterval(tryFill, 500); // every half second
	intervalIds.push(handleFillIntervalId);
};

async function recursiveTryCatch(f: () => void) {
	function sleep(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	try {
		await f();
	} catch (e) {
		console.error(e);
		for (const intervalId of intervalIds) {
			clearInterval(intervalId);
		}
		await sleep(15000);
		await recursiveTryCatch(f);
	}
}

recursiveTryCatch(() => runBot(wallet, clearingHouse));
