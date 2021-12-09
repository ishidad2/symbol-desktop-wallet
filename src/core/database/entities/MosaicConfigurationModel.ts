/*
 * (C) Symbol Contributors 2021
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
/**
 * POJO that stores user provided configuration for mosaics.
 *
 * The object is serialized and deserialized to/from JSON. no method or complex attributes can be fined.
 */
export class MosaicConfigurationModel {
    constructor(public readonly hidden: boolean = false) {}
}
export type AccountMosaicConfigurationModel = Record<string, MosaicConfigurationModel>;
