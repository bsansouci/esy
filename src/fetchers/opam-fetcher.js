/**
 * @flow
 */

import type {FetchedOverride} from '../types.js';
import path from 'path';
import http from 'http';
import {SecurityError} from '../errors.js';
import type {OpamManifest} from '../resolvers/exotics/opam-resolver';
import {parseOpamResolution, lookupOpamPackageManifest} from '../resolvers/exotics/opam-resolver';
import BaseFetcher from '../fetchers/base-fetcher.js';
import * as constants from '../constants.js';
import * as fs from '../util/fs.js';
import * as child from '../util/child.js';
import * as nodeFs from 'fs';
import * as nodeCrypto from 'crypto';

export default class OpamFetcher extends BaseFetcher {

  async _fetch(): Promise<FetchedOverride> {
    const {dest} = this;
    const resolution = parseOpamResolution(this.reference);
    const manifest = await lookupOpamPackageManifest(resolution.name, resolution.version, this.config);
    let hash = this.hash || '';

    if (manifest.opam.url != null) {
      const tarballStorePath = path.join(dest, constants.TARBALL_FILENAME);
      hash = await this._fetchTarball(manifest, tarballStorePath);
      await unpackTarball(tarballStorePath, dest);
    }

    // opam tarballs don't have package.json (obviously) so we put it there
    await writeJson(path.join(dest, 'package.json'), manifest);

    // put extra files
    const {files} = manifest.opam;
    if (files) {
      await Promise.all(files.map((file) =>
        fs.writeFile(path.join(dest, file.name), file.content, 'utf8')),
      );
    }

    // apply patch
    const {patch} = manifest.opam;
    if (patch) {
      const patchFilename = path.join(dest, '_esy_patch');
      await fs.writeFile(patchFilename, patch, 'utf8');
      await child.exec('patch -p1 < _esy_patch', {cwd: dest, shell: '/bin/bash'});
    }

    // TODO: what should we done here?
    const fetchOverride = {hash, resolved: null};
    return fetchOverride;
  }

  _fetchTarball(manifest: OpamManifest, filename: string): Promise<string> {
    const registry = this.config.registries[this.registry];
    return registry.request(manifest.opam.url, {
      headers: {
        'Accept-Encoding': 'gzip',
        'Accept': 'application/octet-stream',
      },
      buffer: true,
      process: (req, resolve, reject) => {
        const {reporter} = this.config;

        const handleRequestError = (res) => {
          if (res.statusCode >= 400) {
            // $FlowFixMe
            const statusDescription = http.STATUS_CODES[res.statusCode];
            reject(new Error(
              reporter.lang('requestFailed', `${res.statusCode} ${statusDescription}`),
            ));
          }
        };

        req.on('response', handleRequestError);
        writeValidatedStream(req, filename, manifest.opam.checksum).then(resolve, reject);
      },
    });
  }

}

function writeValidatedStream(stream, filename, md5checksum = null): Promise<string> {
  const hasher = nodeCrypto.createHash('md5');
  return new Promise((resolve, reject) => {
    const out = nodeFs.createWriteStream(filename);
    stream
      .on('data', (chunk) => {
        if (md5checksum != null) {
          hasher.update(chunk);
        }
      })
      .pipe(out)
      .on('error', (err) => {
        reject(err);
      })
      .on('finish', () => {
        const actualChecksum = hasher.digest('hex');
        if (md5checksum != null) {
          if (actualChecksum !== md5checksum) {
            reject(new SecurityError(
              `Incorrect md5sum (expected ${md5checksum}, got ${actualChecksum})`,
            ));
            return;
          }
        }
        resolve(actualChecksum);
      });
    if (stream.resume) {
      stream.resume();
    }
  });
}

function writeJson(filename, object): Promise<void> {
  const data = JSON.stringify(object, null, 2);
  return fs.writeFile(filename, data, 'utf8');
}

function unpackTarball(filename, dest): Promise<void> {
  return child.exec(
    `tar -xzf ${filename} --strip-components 1 -C ${dest}`,
  );
}
