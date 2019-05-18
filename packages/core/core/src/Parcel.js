// @flow strict-local

import type {
  FilePath,
  InitialParcelOptions,
  ParcelOptions,
  ReporterEvent,
  Stats
} from '@parcel/types';
import type {Bundle} from './types';
import type InternalBundleGraph from './BundleGraph';
import type {Event, Options as WatcherOptions} from '@parcel/watcher';

import {Observable, defer, empty, of} from 'rxjs';
import {
  catchError,
  concat,
  filter,
  switchMap,
  map,
  share,
  tap
} from 'rxjs/operators';
import {Asset} from './public/Asset';
import {BundleGraph} from './public/BundleGraph';
import BundlerRunner from './BundlerRunner';
import WorkerFarm from '@parcel/workers';
import clone from 'clone';
import Cache from '@parcel/cache';
import watcher from '@parcel/watcher';
import path from 'path';
import AssetGraphBuilder, {BuildAbortError} from './AssetGraphBuilder';
import ConfigResolver from './ConfigResolver';
import ReporterRunner from './ReporterRunner';
import MainAssetGraph from './public/MainAssetGraph';
import dumpGraphToGraphViz from './dumpGraphToGraphViz';
import resolveOptions from './resolveOptions';

export default class Parcel {
  #assetGraphBuilder; // AssetGraphBuilder
  #bundlerRunner; // BundlerRunner
  #farm; // WorkerFarm
  #initialized = false; // boolean
  #initialOptions; // InitialParcelOptions;
  #reporterRunner; // ReporterRunner
  #resolvedOptions; // ?ParcelOptions
  #runPackage; // (bundle: Bundle, bundleGraph: InternalBundleGraph) => Promise<Stats>;
  // TODO: this should be private once we have Parcel.watch function
  watchObservable: Observable<ReporterEvent>;

  constructor(options: InitialParcelOptions) {
    this.#initialOptions = clone(options);
  }

  async init(): Promise<void> {
    if (this.#initialized) {
      return;
    }

    let resolvedOptions: ParcelOptions = await resolveOptions(
      this.#initialOptions
    );
    this.#resolvedOptions = resolvedOptions;
    await Cache.createCacheDir(resolvedOptions.cacheDir);

    let configResolver = new ConfigResolver();
    let config;

    // If an explicit `config` option is passed use that, otherwise resolve a .parcelrc from the filesystem.
    if (resolvedOptions.config) {
      config = await configResolver.create(resolvedOptions.config);
    } else {
      config = await configResolver.resolve(resolvedOptions.rootDir);
    }

    // If no config was found, default to the `defaultConfig` option if one is provided.
    if (!config && resolvedOptions.defaultConfig) {
      config = await configResolver.create(resolvedOptions.defaultConfig);
    }

    if (!config) {
      throw new Error('Could not find a .parcelrc');
    }

    this.#bundlerRunner = new BundlerRunner({
      options: resolvedOptions,
      config
    });

    this.#reporterRunner = new ReporterRunner({
      config,
      options: resolvedOptions
    });

    this.#assetGraphBuilder = new AssetGraphBuilder({
      options: resolvedOptions,
      config,
      entries: resolvedOptions.entries,
      targets: resolvedOptions.targets
    });

    this.#farm = await WorkerFarm.getShared(
      {
        config,
        options: resolvedOptions,
        env: resolvedOptions.env
      },
      {
        workerPath: require.resolve('./worker')
      }
    );

    this.#runPackage = this.#farm.mkhandle('runPackage');

    this.#initialized = true;
  }

  // `run()` returns `Promise<?BundleGraph>` because in watch mode it does not
  // return a bundle graph, but outside of watch mode it always will.
  async run(): Promise<BundleGraph> {
    if (!this.#initialized) {
      await this.init();
    }

    return this.build()
      .pipe(
        tap(event => {
          // To fail the observable on the buildFailure case, just throw from within the tap:
          // https://stackoverflow.com/questions/43199642/how-to-throw-error-from-rxjs-map-operator-angular
          if (event.type === 'buildFailure') {
            throw event.error;
          }
        })
      )
      .pipe(filter(event => event.type === 'buildSuccess'))
      .pipe(map(event => event.bundleGraph))
      .toPromise();
  }

  watch(): Observable<ReporterEvent> {
    if (this.watchObservable) {
      return this.watchObservable;
    }

    this.watchObservable = defer(
      () => (this.#initialized ? empty() : this.init())
    )
      .pipe(switchMap(() => this.build()))
      .pipe(
        switchMap(() => {
          let projectRoot = this.#resolvedOptions.projectRoot;
          let targetDirs = this.#resolvedOptions.targets.map(
            target => target.distDir
          );
          let vcsDirs = ['.git', '.hg'].map(dir => path.join(projectRoot, dir));
          let ignore = [
            this.#resolvedOptions.cacheDir,
            ...targetDirs,
            ...vcsDirs
          ];

          return createWatcher(projectRoot, {ignore}).pipe(
            switchMap(events => {
              this.#assetGraphBuilder.respondToFSEvents(events);
              return this.#assetGraphBuilder.isInvalid()
                ? this.build()
                : empty();
            })
          );
        })
      )
      // Share the observable amongst subscribers. `share` also implements `refCount`
      // behavior, so when the last subscriber unsubscribes, the internal watcher
      // will unsubscribe and watching will end.
      .pipe(share());

    return this.watchObservable;
  }

  build(): Observable<ReporterEvent> {
    let startTime = Date.now();
    return of({
      type: 'buildStart'
    })
      .pipe(
        concat(
          defer(() => this.#assetGraphBuilder.build())
            .pipe(
              switchMap(({assetGraph, changedAssets}) => {
                dumpGraphToGraphViz(assetGraph, 'MainAssetGraph');
                return Promise.all([
                  this.#bundlerRunner.bundle(assetGraph),
                  assetGraph,
                  changedAssets
                ]);
              })
            )
            .pipe(
              switchMap(([bundleGraph, assetGraph, changedAssets]) => {
                dumpGraphToGraphViz(bundleGraph, 'BundleGraph');
                return Promise.all([
                  bundleGraph,
                  assetGraph,
                  changedAssets,
                  packageBundles(bundleGraph, this.#runPackage)
                ]);
              })
            )
            .pipe(
              switchMap(([bundleGraph, assetGraph, changedAssets]) => {
                return of({
                  type: 'buildSuccess',
                  changedAssets: new Map(
                    Array.from(changedAssets).map(([id, asset]) => [
                      id,
                      new Asset(asset)
                    ])
                  ),
                  assetGraph: new MainAssetGraph(assetGraph),
                  bundleGraph: new BundleGraph(bundleGraph),
                  buildTime: Date.now() - startTime
                });
              })
            )
            .pipe(
              catchError(e => {
                if (!(e instanceof BuildAbortError)) {
                  return of({
                    type: 'buildFailure',
                    error: e
                  });
                }

                throw new BuildError(e);
              })
            )
        )
      )
      .pipe(
        tap(event => {
          this.#reporterRunner.report(event);
        })
      );
  }
}

// Wraps @parcel/watcher in an RxJS Observable
function createWatcher(
  projectRoot: FilePath,
  options: WatcherOptions
): Observable<Array<Event>> {
  return new Observable(subscriber => {
    let subscribePromise = watcher
      .subscribe(
        projectRoot,
        (err, events) => {
          if (err == null) {
            subscriber.next(events);
          } else {
            subscriber.error(err);
          }
        },
        options
      )
      .catch(err => subscriber.error(err));

    return () =>
      // TODO: What happens when unsubscribing fails?
      subscribePromise.then(subscription => {
        if (subscription != null) {
          subscription.unsubscribe();
        }
      });
  });
}

function packageBundles(
  bundleGraph: InternalBundleGraph,
  runPackage: (
    bundle: Bundle,
    bundleGraph: InternalBundleGraph
  ) => Promise<Stats>
): Promise<mixed> {
  let promises = [];
  bundleGraph.traverseBundles(bundle => {
    promises.push(
      runPackage(bundle, bundleGraph).then(stats => {
        bundle.stats = stats;
      })
    );
  });

  return Promise.all(promises);
}

export class BuildError extends Error {
  name = 'BuildError';
  error: mixed;

  constructor(error: mixed) {
    super(error instanceof Error ? error.message : 'Unknown Build Error');
    this.error = error;
  }
}

export {default as Asset} from './Asset';
export {default as Dependency} from './Dependency';
export {default as Environment} from './Environment';
