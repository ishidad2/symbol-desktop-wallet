/*
 * Copyright 2020 NEM (https://nem.io)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and limitations under the License.
 *
 */

import {
    Account,
    AggregateTransaction,
    Deadline,
    DeadlineService,
    LockFundsTransaction,
    Mosaic,
    MosaicId,
    NetworkType,
    PublicAccount,
    RepositoryFactory,
    SignedTransaction,
    Transaction,
    TransactionFees,
    UInt64,
} from 'symbol-sdk';
import { Signer } from '@/store/Account';
import { NetworkConfigurationModel } from '@/core/database/entities/NetworkConfigurationModel';
import { from, Observable, of } from 'rxjs';
import { AccountTransactionSigner, TransactionAnnouncerService, TransactionSigner } from '@/services/TransactionAnnouncerService';
import { BroadcastResult } from '@/core/transactions/BroadcastResult';
import { flatMap, map } from 'rxjs/operators';
import { AppStore } from '@/app/AppStore';

export enum TransactionCommandMode {
    SIMPLE = 'SIMPLE',
    AGGREGATE = 'AGGREGATE',
    MULTISIGN = 'MULTISIGN',
    CHAINED_BINARY = 'CHAINED_BINARY',
}

export class TransactionCommand {
    private readonly tempAccount: Account;
    private readonly tempTransactionSigner: TransactionSigner;
    constructor(
        public readonly mode: TransactionCommandMode,
        public readonly signer: Signer,
        public readonly signerPublicKey: string,
        public readonly stageTransactions: Transaction[],
        public readonly networkMosaic: MosaicId,
        public readonly generationHash: string,
        public readonly networkType: NetworkType,
        public readonly epochAdjustment: number,
        public readonly networkConfiguration: NetworkConfigurationModel,
        public readonly transactionFees: TransactionFees,
        public readonly requiredCosignatures: number,
    ) {
        this.tempAccount = Account.generateNewAccount(this.networkType);
        this.tempTransactionSigner = new AccountTransactionSigner(this.tempAccount);
    }

    public async sign(
        service: TransactionAnnouncerService,
        account: TransactionSigner,
    ): Promise<Observable<Observable<SignedTransaction>[]>> {
        return of(await this.resolveTransactions(account)).pipe(
            flatMap((transactions) => {
                return of(transactions.map((t) => account.signTransaction(t, this.generationHash))).toPromise();
            }),
        );
    }

    public async announce(service: TransactionAnnouncerService, account: TransactionSigner): Promise<Observable<BroadcastResult>[]> {
        return of(await this.resolveTransactions(account))
            .pipe(
                flatMap((transactions) => {
                    const signedTransactions = transactions.map((t) => account.signTransaction(t, this.generationHash));
                    if (!signedTransactions.length) {
                        return of([]);
                    }
                    if (this.mode == TransactionCommandMode.MULTISIGN) {
                        return of([this.announceHashAndAggregateBonded(service, signedTransactions)]);
                    } else if (this.mode == TransactionCommandMode.CHAINED_BINARY) {
                        return of([this.announceChainedBinary(service, signedTransactions)]);
                    } else {
                        return of(this.announceSimple(service, signedTransactions));
                    }
                }),
            )
            .toPromise();
    }

    private announceChainedBinary(
        service: TransactionAnnouncerService,
        signedTransactions: Observable<SignedTransaction>[],
    ): Observable<BroadcastResult> {
        return signedTransactions[0].pipe(
            flatMap((first) => {
                return signedTransactions[1].pipe(
                    flatMap((second) => {
                        return service.announceChainedBinary(first, second);
                    }),
                );
            }),
        );
    }

    public announceHashAndAggregateBonded(
        service: TransactionAnnouncerService,
        signedTransactions: Observable<SignedTransaction>[],
    ): Observable<BroadcastResult> {
        return signedTransactions[0].pipe(
            flatMap((signedHashLockTransaction) => {
                return signedTransactions[1].pipe(
                    flatMap((signedAggregateTransaction) => {
                        return service.announceHashAndAggregateBonded(signedHashLockTransaction, signedAggregateTransaction);
                    }),
                );
            }),
        );
    }

    private announceSimple(
        service: TransactionAnnouncerService,
        signedTransactions: Observable<SignedTransaction>[],
    ): Observable<BroadcastResult>[] {
        return signedTransactions.map((o) => o.pipe(flatMap((s) => service.announce(s))));
    }

    public async getTotalMaxFee(): Promise<Observable<UInt64>> {
        const resolvedTransactions = await this.resolveTransactions();
        of(resolvedTransactions).pipe(
            map((ts) => {
                ts.reduce((partial, current) => partial.add(current.maxFee), UInt64.fromUint(0));
            }),
        );
        return of(resolvedTransactions).pipe(map((ts) => ts.reduce((partial, current) => partial.add(current.maxFee), UInt64.fromUint(0))));
    }

    public async resolveTransactions(account: TransactionSigner = this.tempTransactionSigner): Promise<Transaction[]> {
        if (!this.stageTransactions || !this.stageTransactions.length) {
            return from([]).toPromise();
        }
        if (this.stageTransactions && this.stageTransactions.length) {
            const maxFee = this.stageTransactions.sort((a, b) => a.maxFee.compare(b.maxFee))[0].maxFee;
            if (this.mode === TransactionCommandMode.SIMPLE || this.mode === TransactionCommandMode.CHAINED_BINARY) {
                return of(this.stageTransactions.map((t) => this.calculateSuggestedMaxFee(t))).toPromise();
            } else {
                const currentSigner = PublicAccount.createFromPublicKey(this.signerPublicKey, this.networkType);
                if (this.mode === TransactionCommandMode.AGGREGATE) {
                    const aggregateDeadline = await this.createDeadline();
                    const aggregate = this.calculateSuggestedMaxFee(
                        AggregateTransaction.createComplete(
                            aggregateDeadline,
                            this.stageTransactions.map((t) => t.toAggregate(currentSigner)),
                            this.networkType,
                            [],
                            maxFee,
                        ),
                    );
                    return of([aggregate]).toPromise();
                } else {
                    // use attached signer (multisig account) if exists
                    const signedInnerTransactions = this.stageTransactions.map((t) => {
                        return t.signer === undefined ? t.toAggregate(currentSigner) : t.toAggregate(t.signer);
                    });
                    const bondedDeadline = await this.createDeadline(48);
                    const aggregate = this.calculateSuggestedMaxFee(
                        AggregateTransaction.createBonded(bondedDeadline, signedInnerTransactions, this.networkType, [], maxFee),
                    );
                    const hashLockDeadline = await this.createDeadline(6);

                    return account
                        .signTransaction(aggregate, this.generationHash)
                        .pipe(
                            map((signedAggregateTransaction) => {
                                const hashLock = this.calculateSuggestedMaxFee(
                                    LockFundsTransaction.create(
                                        hashLockDeadline,
                                        new Mosaic(
                                            this.networkMosaic,
                                            UInt64.fromNumericString(this.networkConfiguration.lockedFundsPerAggregate),
                                        ),
                                        UInt64.fromUint(5760),
                                        signedAggregateTransaction,
                                        this.networkType,
                                        maxFee,
                                    ),
                                );
                                return [hashLock, aggregate];
                            }),
                        )
                        .toPromise();
                }
            }
        }
    }

    public calculateSuggestedMaxFee(transaction: Transaction): Transaction {
        if (!transaction) {
            return undefined;
        }
        const feeMultiplier = this.resolveFeeMultipler(transaction);
        if (!feeMultiplier) {
            return transaction;
        }
        if (transaction instanceof AggregateTransaction) {
            return transaction.setMaxFeeForAggregate(feeMultiplier, this.requiredCosignatures);
        } else {
            return transaction.setMaxFee(feeMultiplier);
        }
    }

    private resolveFeeMultipler(transaction: Transaction): number | undefined {
        // average
        if (transaction.maxFee.compact() === 10) {
            const fees = this.transactionFees.minFeeMultiplier + this.transactionFees.averageFeeMultiplier * 0.65;
            return fees || this.networkConfiguration.defaultDynamicFeeMultiplier;
        }
        // fast
        if (transaction.maxFee.compact() === 20) {
            const fees =
                this.transactionFees.averageFeeMultiplier < this.transactionFees.minFeeMultiplier
                    ? this.transactionFees.minFeeMultiplier
                    : this.transactionFees.averageFeeMultiplier;
            return fees || this.networkConfiguration.defaultDynamicFeeMultiplier;
        }
        // slowest
        if (transaction.maxFee.compact() === 1) {
            const fees = this.transactionFees.minFeeMultiplier;
            return fees || this.networkConfiguration.defaultDynamicFeeMultiplier;
        }
        // slow
        if (transaction.maxFee.compact() === 5) {
            const fees = this.transactionFees.minFeeMultiplier + this.transactionFees.averageFeeMultiplier * 0.35;
            return fees || this.networkConfiguration.defaultDynamicFeeMultiplier;
        }
        return undefined;
    }
    private async createDeadline(deadlineInHours = 2): Promise<Deadline> {
        const repositoryFactory: RepositoryFactory = AppStore.getters['network/repositoryFactory'] as RepositoryFactory;
        const deadline = await (await DeadlineService.create(repositoryFactory)).createDeadlineUsingServerTime(deadlineInHours);
        return deadline;
    }
}
