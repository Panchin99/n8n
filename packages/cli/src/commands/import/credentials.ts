import { flags } from '@oclif/command';
import { Credentials } from 'n8n-core';
import fs from 'fs';
import glob from 'fast-glob';
import type { EntityManager } from 'typeorm';
import config from '@/config';
import * as Db from '@/Db';
import type { User } from '@db/entities/User';
import { SharedCredentials } from '@db/entities/SharedCredentials';
import { CredentialsEntity } from '@db/entities/CredentialsEntity';
import { ROLES } from '@/constants';
import { disableAutoGeneratedIds } from '@db/utils/commandHelpers';
import { BaseCommand, UM_FIX_INSTRUCTION } from '../BaseCommand';
import type { ICredentialsEncrypted } from 'n8n-workflow';
import { jsonParse } from 'n8n-workflow';

export class ImportCredentialsCommand extends BaseCommand {
	static description = 'Import credentials';

	static examples = [
		'$ n8n import:credentials --input=file.json',
		'$ n8n import:credentials --separate --input=backups/latest/',
		'$ n8n import:credentials --input=file.json --userId=1d64c3d2-85fe-4a83-a649-e446b07b3aae',
		'$ n8n import:credentials --separate --input=backups/latest/ --userId=1d64c3d2-85fe-4a83-a649-e446b07b3aae',
	];

	static flags = {
		help: flags.help({ char: 'h' }),
		input: flags.string({
			char: 'i',
			description: 'Input file name or directory if --separate is used',
		}),
		separate: flags.boolean({
			description: 'Imports *.json files from directory provided by --input',
		}),
		userId: flags.string({
			description: 'The ID of the user to assign the imported credentials to',
		}),
	};

	private transactionManager: EntityManager;

	async init() {
		disableAutoGeneratedIds(CredentialsEntity);
		await super.init();
	}

	async run(): Promise<void> {
		// eslint-disable-next-line @typescript-eslint/no-shadow
		const { flags } = this.parse(ImportCredentialsCommand);

		if (!flags.input) {
			this.logger.info('An input file or directory with --input must be provided');
			return;
		}

		if (flags.separate) {
			if (fs.existsSync(flags.input)) {
				if (!fs.lstatSync(flags.input).isDirectory()) {
					this.logger.info('The argument to --input must be a directory');
					return;
				}
			}
		}

		let totalImported = 0;

		const user = flags.userId ? await this.getAssignee(flags.userId) : await this.getOwner();

		const encryptionKey = this.userSettings.encryptionKey;

		if (flags.separate) {
			let { input: inputPath } = flags;

			if (process.platform === 'win32') {
				inputPath = inputPath.replace(/\\/g, '/');
			}

			const files = await glob('*.json', {
				cwd: inputPath,
				absolute: true,
			});

			totalImported = files.length;

			await Db.getConnection().transaction(async (transactionManager) => {
				this.transactionManager = transactionManager;
				for (const file of files) {
					const credential = jsonParse<ICredentialsEncrypted>(
						fs.readFileSync(file, { encoding: 'utf8' }),
					);

					if (typeof credential.data === 'object') {
						// plain data / decrypted input. Should be encrypted first.
						Credentials.prototype.setData.call(credential, credential.data, encryptionKey);
					}

					await this.storeCredential(credential, user);
				}
			});

			this.reportSuccess(totalImported);
			return;
		}

		const credentials = jsonParse<ICredentialsEncrypted[]>(
			fs.readFileSync(flags.input, { encoding: 'utf8' }),
		);

		totalImported = credentials.length;

		if (!Array.isArray(credentials)) {
			throw new Error(
				'File does not seem to contain credentials. Make sure the credentials are contained in an array.',
			);
		}

		await Db.getConnection().transaction(async (transactionManager) => {
			this.transactionManager = transactionManager;
			for (const credential of credentials) {
				if (typeof credential.data === 'object') {
					// plain data / decrypted input. Should be encrypted first.
					Credentials.prototype.setData.call(credential, credential.data, encryptionKey);
				}
				await this.storeCredential(credential, user);
			}
		});

		this.reportSuccess(totalImported);
	}

	async catch(error: Error) {
		this.logger.error(
			'An error occurred while importing credentials. See log messages for details.',
		);
		this.logger.error(error.message);
	}

	private reportSuccess(total: number) {
		this.logger.info(
			`Successfully imported ${total} ${total === 1 ? 'credential.' : 'credentials.'}`,
		);
	}

	private async storeCredential(credential: object, user: User) {
		const result = await this.transactionManager.upsert(CredentialsEntity, credential, ['id']);
		await this.transactionManager.upsert(
			SharedCredentials,
			{
				credentialsId: result.identifiers[0].id as string,
				userId: user.id,
				role: ROLES.CREDENTIAL_OWNER,
			},
			['credentialsId', 'userId'],
		);
		if (config.getEnv('database.type') === 'postgresdb') {
			const tablePrefix = config.getEnv('database.tablePrefix');
			await this.transactionManager.query(
				`SELECT setval('${tablePrefix}credentials_entity_id_seq', (SELECT MAX(id) from ${tablePrefix}credentials_entity))`,
			);
		}
	}

	private async getOwner() {
		const owner = await Db.collections.User.findOneBy({ role: ROLES.GLOBAL_OWNER });

		if (!owner) {
			throw new Error(`Failed to find owner. ${UM_FIX_INSTRUCTION}`);
		}

		return owner;
	}

	private async getAssignee(userId: string) {
		const user = await Db.collections.User.findOneBy({ id: userId });

		if (!user) {
			throw new Error(`Failed to find user with ID ${userId}`);
		}

		return user;
	}
}
