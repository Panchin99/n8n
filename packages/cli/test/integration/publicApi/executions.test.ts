import type { Application } from 'express';
import type { SuperAgentTest } from 'supertest';
import config from '@/config';
import type { User } from '@db/entities/User';
import type { ActiveWorkflowRunner } from '@/ActiveWorkflowRunner';

import { randomApiKey } from '../shared/random';
import * as utils from '../shared/utils';
import * as testDb from '../shared/testDb';
import { ROLES } from '@/constants';

let app: Application;
let owner: User;
let user1: User;
let user2: User;
let authOwnerAgent: SuperAgentTest;
let authUser1Agent: SuperAgentTest;
let authUser2Agent: SuperAgentTest;
let workflowRunner: ActiveWorkflowRunner;

beforeAll(async () => {
	app = await utils.initTestServer({
		endpointGroups: ['publicApi'],
		applyAuth: false,
		enablePublicAPI: true,
	});

	owner = await testDb.createUser({ role: ROLES.GLOBAL_OWNER, apiKey: randomApiKey() });
	user1 = await testDb.createUser({ role: ROLES.GLOBAL_MEMBER, apiKey: randomApiKey() });
	user2 = await testDb.createUser({ role: ROLES.GLOBAL_MEMBER, apiKey: randomApiKey() });

	await utils.initBinaryManager();
	await utils.initNodeTypes();

	workflowRunner = await utils.initActiveWorkflowRunner();
});

beforeEach(async () => {
	await testDb.truncate([
		'SharedCredentials',
		'SharedWorkflow',
		'Workflow',
		'Credentials',
		'Execution',
		'Settings',
	]);

	authOwnerAgent = utils.createAgent(app, {
		apiPath: 'public',
		auth: true,
		user: owner,
		version: 1,
	});

	authUser1Agent = utils.createAgent(app, {
		apiPath: 'public',
		auth: true,
		user: user1,
		version: 1,
	});

	authUser2Agent = utils.createAgent(app, {
		apiPath: 'public',
		auth: true,
		user: user2,
		version: 1,
	});

	config.set('userManagement.disabled', false);
	config.set('userManagement.isInstanceOwnerSetUp', true);
});

afterEach(async () => {
	await workflowRunner?.removeAll();
});

afterAll(async () => {
	await testDb.terminate();
});

const testWithAPIKey =
	(method: 'get' | 'post' | 'put' | 'delete', url: string, apiKey: string | null) => async () => {
		void authOwnerAgent.set({ 'X-N8N-API-KEY': apiKey });
		const response = await authOwnerAgent[method](url);
		expect(response.statusCode).toBe(401);
	};

describe('GET /executions/:id', () => {
	test('should fail due to missing API Key', testWithAPIKey('get', '/executions/1', null));

	test('should fail due to invalid API Key', testWithAPIKey('get', '/executions/1', 'abcXYZ'));

	test('owner should be able to get an execution owned by him', async () => {
		const workflow = await testDb.createWorkflow({}, owner);

		const execution = await testDb.createSuccessfulExecution(workflow);

		const response = await authOwnerAgent.get(`/executions/${execution.id}`);

		expect(response.statusCode).toBe(200);

		const {
			id,
			finished,
			mode,
			retryOf,
			retrySuccessId,
			startedAt,
			stoppedAt,
			workflowId,
			waitTill,
		} = response.body;

		expect(id).toBeDefined();
		expect(finished).toBe(true);
		expect(mode).toEqual(execution.mode);
		expect(retrySuccessId).toBeNull();
		expect(retryOf).toBeNull();
		expect(startedAt).not.toBeNull();
		expect(stoppedAt).not.toBeNull();
		expect(workflowId).toBe(execution.workflowId);
		expect(waitTill).toBeNull();
	});

	test('owner should be able to read executions of other users', async () => {
		const workflow = await testDb.createWorkflow({}, user1);
		const execution = await testDb.createSuccessfulExecution(workflow);

		const response = await authOwnerAgent.get(`/executions/${execution.id}`);

		expect(response.statusCode).toBe(200);
	});

	test('member should be able to fetch his own executions', async () => {
		const workflow = await testDb.createWorkflow({}, user1);
		const execution = await testDb.createSuccessfulExecution(workflow);

		const response = await authUser1Agent.get(`/executions/${execution.id}`);

		expect(response.statusCode).toBe(200);
	});

	test('member should not get an execution of another user without the workflow being shared', async () => {
		const workflow = await testDb.createWorkflow({}, owner);

		const execution = await testDb.createSuccessfulExecution(workflow);

		const response = await authUser1Agent.get(`/executions/${execution.id}`);

		expect(response.statusCode).toBe(404);
	});

	test('member should be able to fetch executions of workflows shared with him', async () => {
		const workflow = await testDb.createWorkflow({}, user1);

		const execution = await testDb.createSuccessfulExecution(workflow);

		await testDb.shareWorkflowWithUsers(workflow, [user2]);

		const response = await authUser2Agent.get(`/executions/${execution.id}`);

		expect(response.statusCode).toBe(200);
	});
});

describe('DELETE /executions/:id', () => {
	test('should fail due to missing API Key', testWithAPIKey('delete', '/executions/1', null));

	test('should fail due to invalid API Key', testWithAPIKey('delete', '/executions/1', 'abcXYZ'));

	test('should delete an execution', async () => {
		const workflow = await testDb.createWorkflow({}, owner);
		const execution = await testDb.createSuccessfulExecution(workflow);

		const response = await authOwnerAgent.delete(`/executions/${execution.id}`);

		expect(response.statusCode).toBe(200);

		const {
			id,
			finished,
			mode,
			retryOf,
			retrySuccessId,
			startedAt,
			stoppedAt,
			workflowId,
			waitTill,
		} = response.body;

		expect(id).toBeDefined();
		expect(finished).toBe(true);
		expect(mode).toEqual(execution.mode);
		expect(retrySuccessId).toBeNull();
		expect(retryOf).toBeNull();
		expect(startedAt).not.toBeNull();
		expect(stoppedAt).not.toBeNull();
		expect(workflowId).toBe(execution.workflowId);
		expect(waitTill).toBeNull();
	});
});

describe('GET /executions', () => {
	test('should fail due to missing API Key', testWithAPIKey('get', '/executions', null));

	test('should fail due to invalid API Key', testWithAPIKey('get', '/executions', 'abcXYZ'));

	test('should retrieve all successful executions', async () => {
		const workflow = await testDb.createWorkflow({}, owner);

		const successfulExecution = await testDb.createSuccessfulExecution(workflow);

		await testDb.createErrorExecution(workflow);

		const response = await authOwnerAgent.get('/executions').query({
			status: 'success',
		});

		expect(response.statusCode).toBe(200);
		expect(response.body.data.length).toBe(1);
		expect(response.body.nextCursor).toBe(null);

		const {
			id,
			finished,
			mode,
			retryOf,
			retrySuccessId,
			startedAt,
			stoppedAt,
			workflowId,
			waitTill,
		} = response.body.data[0];

		expect(id).toBeDefined();
		expect(finished).toBe(true);
		expect(mode).toEqual(successfulExecution.mode);
		expect(retrySuccessId).toBeNull();
		expect(retryOf).toBeNull();
		expect(startedAt).not.toBeNull();
		expect(stoppedAt).not.toBeNull();
		expect(workflowId).toBe(successfulExecution.workflowId);
		expect(waitTill).toBeNull();
	});

	// failing on Postgres and MySQL - ref: https://github.com/n8n-io/n8n/pull/3834
	// eslint-disable-next-line n8n-local-rules/no-skipped-tests
	test.skip('should paginate two executions', async () => {
		const workflow = await testDb.createWorkflow({}, owner);

		const firstSuccessfulExecution = await testDb.createSuccessfulExecution(workflow);

		const secondSuccessfulExecution = await testDb.createSuccessfulExecution(workflow);

		await testDb.createErrorExecution(workflow);

		const firstExecutionResponse = await authOwnerAgent.get('/executions').query({
			status: 'success',
			limit: 1,
		});

		expect(firstExecutionResponse.statusCode).toBe(200);
		expect(firstExecutionResponse.body.data.length).toBe(1);
		expect(firstExecutionResponse.body.nextCursor).toBeDefined();

		const secondExecutionResponse = await authOwnerAgent.get('/executions').query({
			status: 'success',
			limit: 1,
			cursor: firstExecutionResponse.body.nextCursor,
		});

		expect(secondExecutionResponse.statusCode).toBe(200);
		expect(secondExecutionResponse.body.data.length).toBe(1);
		expect(secondExecutionResponse.body.nextCursor).toBeNull();

		const successfulExecutions = [firstSuccessfulExecution, secondSuccessfulExecution];
		const executions = [...firstExecutionResponse.body.data, ...secondExecutionResponse.body.data];

		for (let i = 0; i < executions.length; i++) {
			const {
				id,
				finished,
				mode,
				retryOf,
				retrySuccessId,
				startedAt,
				stoppedAt,
				workflowId,
				waitTill,
			} = executions[i];

			expect(id).toBeDefined();
			expect(finished).toBe(true);
			expect(mode).toEqual(successfulExecutions[i].mode);
			expect(retrySuccessId).toBeNull();
			expect(retryOf).toBeNull();
			expect(startedAt).not.toBeNull();
			expect(stoppedAt).not.toBeNull();
			expect(workflowId).toBe(successfulExecutions[i].workflowId);
			expect(waitTill).toBeNull();
		}
	});

	test('should retrieve all error executions', async () => {
		const workflow = await testDb.createWorkflow({}, owner);

		await testDb.createSuccessfulExecution(workflow);

		const errorExecution = await testDb.createErrorExecution(workflow);

		const response = await authOwnerAgent.get('/executions').query({
			status: 'error',
		});

		expect(response.statusCode).toBe(200);
		expect(response.body.data.length).toBe(1);
		expect(response.body.nextCursor).toBe(null);

		const {
			id,
			finished,
			mode,
			retryOf,
			retrySuccessId,
			startedAt,
			stoppedAt,
			workflowId,
			waitTill,
		} = response.body.data[0];

		expect(id).toBeDefined();
		expect(finished).toBe(false);
		expect(mode).toEqual(errorExecution.mode);
		expect(retrySuccessId).toBeNull();
		expect(retryOf).toBeNull();
		expect(startedAt).not.toBeNull();
		expect(stoppedAt).not.toBeNull();
		expect(workflowId).toBe(errorExecution.workflowId);
		expect(waitTill).toBeNull();
	});

	test('should return all waiting executions', async () => {
		const workflow = await testDb.createWorkflow({}, owner);

		await testDb.createSuccessfulExecution(workflow);

		await testDb.createErrorExecution(workflow);

		const waitingExecution = await testDb.createWaitingExecution(workflow);

		const response = await authOwnerAgent.get('/executions').query({
			status: 'waiting',
		});

		expect(response.statusCode).toBe(200);
		expect(response.body.data.length).toBe(1);
		expect(response.body.nextCursor).toBe(null);

		const {
			id,
			finished,
			mode,
			retryOf,
			retrySuccessId,
			startedAt,
			stoppedAt,
			workflowId,
			waitTill,
		} = response.body.data[0];

		expect(id).toBeDefined();
		expect(finished).toBe(false);
		expect(mode).toEqual(waitingExecution.mode);
		expect(retrySuccessId).toBeNull();
		expect(retryOf).toBeNull();
		expect(startedAt).not.toBeNull();
		expect(stoppedAt).not.toBeNull();
		expect(workflowId).toBe(waitingExecution.workflowId);
		expect(new Date(waitTill).getTime()).toBeGreaterThan(Date.now() - 1000);
	});

	test('should retrieve all executions of specific workflow', async () => {
		const [workflow, workflow2] = await testDb.createManyWorkflows(2, {}, owner);

		const savedExecutions = await testDb.createManyExecutions(
			2,
			workflow,
			testDb.createSuccessfulExecution,
		);
		await testDb.createManyExecutions(2, workflow2, testDb.createSuccessfulExecution);

		const response = await authOwnerAgent.get('/executions').query({
			workflowId: workflow.id,
		});

		expect(response.statusCode).toBe(200);
		expect(response.body.data.length).toBe(2);
		expect(response.body.nextCursor).toBe(null);

		for (const execution of response.body.data) {
			const {
				id,
				finished,
				mode,
				retryOf,
				retrySuccessId,
				startedAt,
				stoppedAt,
				workflowId,
				waitTill,
			} = execution;

			expect(savedExecutions.some((exec) => exec.id === id)).toBe(true);
			expect(finished).toBe(true);
			expect(mode).toBeDefined();
			expect(retrySuccessId).toBeNull();
			expect(retryOf).toBeNull();
			expect(startedAt).not.toBeNull();
			expect(stoppedAt).not.toBeNull();
			expect(workflowId).toBe(workflow.id);
			expect(waitTill).toBeNull();
		}
	});

	test('owner should retrieve all executions regardless of ownership', async () => {
		const [firstWorkflowForUser1, secondWorkflowForUser1] = await testDb.createManyWorkflows(
			2,
			{},
			user1,
		);
		await testDb.createManyExecutions(2, firstWorkflowForUser1, testDb.createSuccessfulExecution);
		await testDb.createManyExecutions(2, secondWorkflowForUser1, testDb.createSuccessfulExecution);

		const [firstWorkflowForUser2, secondWorkflowForUser2] = await testDb.createManyWorkflows(
			2,
			{},
			user2,
		);
		await testDb.createManyExecutions(2, firstWorkflowForUser2, testDb.createSuccessfulExecution);
		await testDb.createManyExecutions(2, secondWorkflowForUser2, testDb.createSuccessfulExecution);

		const response = await authOwnerAgent.get('/executions');

		expect(response.statusCode).toBe(200);
		expect(response.body.data.length).toBe(8);
		expect(response.body.nextCursor).toBe(null);
	});

	test('member should not see executions of workflows not shared with him', async () => {
		const [firstWorkflowForUser1, secondWorkflowForUser1] = await testDb.createManyWorkflows(
			2,
			{},
			user1,
		);
		await testDb.createManyExecutions(2, firstWorkflowForUser1, testDb.createSuccessfulExecution);
		await testDb.createManyExecutions(2, secondWorkflowForUser1, testDb.createSuccessfulExecution);

		const [firstWorkflowForUser2, secondWorkflowForUser2] = await testDb.createManyWorkflows(
			2,
			{},
			user2,
		);
		await testDb.createManyExecutions(2, firstWorkflowForUser2, testDb.createSuccessfulExecution);
		await testDb.createManyExecutions(2, secondWorkflowForUser2, testDb.createSuccessfulExecution);

		const response = await authUser1Agent.get('/executions');

		expect(response.statusCode).toBe(200);
		expect(response.body.data.length).toBe(4);
		expect(response.body.nextCursor).toBe(null);
	});

	test('member should also see executions of workflows shared with him', async () => {
		const [firstWorkflowForUser1, secondWorkflowForUser1] = await testDb.createManyWorkflows(
			2,
			{},
			user1,
		);
		await testDb.createManyExecutions(2, firstWorkflowForUser1, testDb.createSuccessfulExecution);
		await testDb.createManyExecutions(2, secondWorkflowForUser1, testDb.createSuccessfulExecution);

		const [firstWorkflowForUser2, secondWorkflowForUser2] = await testDb.createManyWorkflows(
			2,
			{},
			user2,
		);
		await testDb.createManyExecutions(2, firstWorkflowForUser2, testDb.createSuccessfulExecution);
		await testDb.createManyExecutions(2, secondWorkflowForUser2, testDb.createSuccessfulExecution);

		await testDb.shareWorkflowWithUsers(firstWorkflowForUser2, [user1]);

		const response = await authUser1Agent.get('/executions');

		expect(response.statusCode).toBe(200);
		expect(response.body.data.length).toBe(6);
		expect(response.body.nextCursor).toBe(null);
	});
});
