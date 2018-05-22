/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 * @format
 */

import type {LauncherParameters} from '../../server/NuclideServer';
import type {Transport} from '../../server/BigDigServer';

import {SocketManager} from './SocketManager';

import {getLogger} from 'log4js';
import invariant from 'assert';

const logger = getLogger('tunnel-service');

// eslint-disable-next-line nuclide-internal/no-commonjs
module.exports = function launch(
  launcherParams: LauncherParameters,
): Promise<void> {
  const {server} = launcherParams;
  logger.info('adding tunnel subscriber!');
  const idToSocketManager: Map<string, SocketManager> = new Map();

  server.addSubscriber('tunnel', {
    onConnection(transport: Transport) {
      logger.info('connection made!');

      transport.onMessage().subscribe(async data => {
        const message = JSON.parse(data);
        const event = message.event;
        const tunnelId = message.tunnelId;
        const socketManager: ?SocketManager = idToSocketManager.get(tunnelId);

        if (event === 'proxyCreated') {
          logger.info('creating connection manager');
          idToSocketManager.set(
            tunnelId,
            new SocketManager(message.tunnelId, message.remotePort, transport),
          );
        } else if (event === 'connection' || event === 'data') {
          invariant(socketManager);
          socketManager.send(message);
        } else if (event === 'proxyClosed') {
          invariant(socketManager);
          socketManager.close();
        }
      });
    },
  });

  return Promise.resolve();
};