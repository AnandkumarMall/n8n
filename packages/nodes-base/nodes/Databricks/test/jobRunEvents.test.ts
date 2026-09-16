import type {
	IDataObject,
	INode,
	IPollFunctions,
	JsonObject,
	NodeParameterValueType,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { mock, mockDeep } from 'vitest-mock-extended';

import type { DatabricksJobRun } from '../actions/interfaces';
import { DEFAULT_MAX_PAGES, JOB_RUNS_MAX_PAGE_SIZE } from '../transport';
import { OVERLAP_MS, pollJobRunEvents } from '../trigger/jobRunEvents';

const HOST = 'https://adb-example.cloud.databricks.com';
const JOB_ID = 281874479417551;
const RUN_ID = 41847992357943;
const START_TIME = 1756733838171;
const END_TIME = 1756733878640;
const NOW = END_TIME + 10 * 60 * 1000;
const CURSOR = START_TIME - 1000;

const node = mock<INode>({ name: 'Databricks Trigger', typeVersion: 1 });

const jobParameters = (...parameters: NonNullable<DatabricksJobRun['job_parameters']>) =>
	parameters;

const failedRun: DatabricksJobRun = {
	job_id: JOB_ID,
	run_id: RUN_ID,
	run_name: 'n8n-spike-webhook-test',
	run_page_url: `${HOST}/?o=1234567890#job/${JOB_ID}/run/${RUN_ID}`,
	trigger: 'ONE_TIME',
	creator_user_name: 'service-principal@example.com',
	job_parameters: jobParameters({ name: 'fail', value: 'true' }),
	start_time: START_TIME,
	end_time: END_TIME,
	run_duration: 40469,
	queue_duration: 14111,
	status: {
		state: 'TERMINATED',
		termination_details: {
			code: 'RUN_EXECUTION_ERROR',
			type: 'CLIENT_ERROR',
			message: 'Task main failed with message: Workload failed, see run output for details.',
		},
	},
};

const succeededRun: DatabricksJobRun = {
	...failedRun,
	job_parameters: jobParameters({ name: 'fail', default: 'false' }),
	status: { state: 'TERMINATED', termination_details: { code: 'SUCCESS', type: 'SUCCESS' } },
};

const runningRun: DatabricksJobRun = {
	...failedRun,
	end_time: 0,
	run_duration: undefined,
	status: { state: 'RUNNING' },
};

const runAt = (runId: number, startTime: number, base: DatabricksJobRun = succeededRun) => ({
	...base,
	run_id: runId,
	start_time: startTime,
	end_time: base.end_time ? startTime + 1000 : 0,
});

const simplifiedFailedRun = {
	event: 'runFailed',
	job: { id: JOB_ID },
	run: {
		id: RUN_ID,
		name: 'n8n-spike-webhook-test',
		url: `${HOST}/?o=1234567890#job/${JOB_ID}/run/${RUN_ID}`,
		trigger: 'ONE_TIME',
		creator: 'service-principal@example.com',
		parameters: { fail: 'true' },
	},
	result: {
		state: 'TERMINATED',
		code: 'RUN_EXECUTION_ERROR',
		type: 'CLIENT_ERROR',
		message: 'Task main failed with message: Workload failed, see run output for details.',
	},
	timing: {
		startedAt: '2025-09-01T13:37:18.171Z',
		endedAt: '2025-09-01T13:37:58.640Z',
		durationMs: 40469,
		queuedMs: 14111,
	},
};

class AxiosError extends Error {
	constructor(
		message: string,
		readonly response: { status: number; data: unknown },
	) {
		super(message);
	}
}

const apiErrorFromBody = (status: number, data: unknown) =>
	new NodeApiError(
		node,
		new AxiosError(`Request failed with status code ${status}`, {
			status,
			data,
		}) as unknown as JsonObject,
	);

type ContextOptions = {
	events?: NodeParameterValueType;
	simplify?: boolean;
	jobId?: string;
	mode?: 'trigger' | 'manual';
	staticData?: IDataObject;
};

const watchingState = (runs: IDataObject = {}, cursorMs = CURSOR): IDataObject => ({
	jobId: JOB_ID,
	cursorMs,
	floorMs: cursorMs - OVERLAP_MS,
	runs,
});

const createContext = (options: ContextOptions = {}) => {
	const context = mockDeep<IPollFunctions>();
	const staticData = options.staticData ?? {};
	context.getNode.mockReturnValue(node);
	context.getMode.mockReturnValue(options.mode ?? 'trigger');
	context.getWorkflowStaticData.mockReturnValue(staticData);
	context.getCredentials.mockResolvedValue({ host: HOST });
	context.getNodeParameter.mockImplementation((name, fallback) => {
		switch (name) {
			case 'authentication':
				return 'accessToken';
			case 'events':
				return options.events ?? ['runFailed', 'runSucceeded'];
			case 'simplify':
				return options.simplify ?? true;
			case 'jobId':
				return options.jobId ?? String(JOB_ID);
			default:
				return fallback;
		}
	});
	const api = context.helpers.httpRequestWithAuthentication;
	const requestQuery = (call = 0) => api.mock.calls[call][1].qs;
	const poll = async () => await pollJobRunEvents.call(context);
	const events = async () =>
		((await poll()) ?? [[]])[0].map((item) => ({ event: item.json.event, run: item.json.run }));
	return { context, staticData, api, requestQuery, poll, events };
};

describe('pollJobRunEvents', () => {
	beforeEach(() => {
		vi.spyOn(Date, 'now').mockReturnValue(NOW);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('first poll', () => {
		it('starts watching from now without calling the API', async () => {
			const { staticData, api, poll } = createContext();

			await expect(poll()).resolves.toBeNull();

			expect(staticData).toEqual(watchingState({}, NOW));
			expect(api).not.toHaveBeenCalled();
		});

		it.each([
			[
				'state of another job',
				{ ...watchingState({ '7': { startMs: 5, started: true, terminal: false } }, 5), jobId: 1 },
			],
			['state with a broken shape', { jobId: JOB_ID, cursorMs: 'yesterday', runs: [] }],
			['state without a floor', { jobId: JOB_ID, cursorMs: CURSOR, runs: {} }],
			['state with a broken run entry', watchingState({ '7': { startMs: 5 } })],
		])('resets %s in place', async (_label, stale) => {
			const staticData: IDataObject = { ...stale };
			const { api, poll } = createContext({ staticData });

			await expect(poll()).resolves.toBeNull();

			expect(staticData).toEqual(watchingState({}, NOW));
			expect(api).not.toHaveBeenCalled();
		});
	});

	describe('classification', () => {
		it('emits one runFailed item with the simplified shape for a failed run', async () => {
			const { context, staticData, api, requestQuery, poll } = createContext({
				staticData: watchingState(),
			});
			api.mockResolvedValue({ runs: [failedRun] });

			await expect(poll()).resolves.toEqual([[{ json: simplifiedFailedRun }]]);

			expect(context.getNodeParameter).toHaveBeenCalledWith('jobId', '', { extractValue: true });
			expect(api).toHaveBeenCalledTimes(1);
			expect(requestQuery()).toEqual({
				job_id: JOB_ID,
				start_time_from: CURSOR - OVERLAP_MS,
				limit: JOB_RUNS_MAX_PAGE_SIZE,
			});
			expect(staticData).toEqual(
				watchingState(
					{ [RUN_ID]: { startMs: START_TIME, started: true, terminal: true } },
					START_TIME,
				),
			);
		});

		it('emits runSucceeded with code SUCCESS and no message for a successful run', async () => {
			const { api, poll } = createContext({ staticData: watchingState() });
			api.mockResolvedValue({ runs: [succeededRun] });

			const result = await poll();

			expect(result).toHaveLength(1);
			expect(result?.[0]).toHaveLength(1);
			expect(result?.[0][0].json).toMatchObject({
				event: 'runSucceeded',
				run: { parameters: { fail: 'false' } },
				result: { state: 'TERMINATED', code: 'SUCCESS', type: 'SUCCESS' },
			});
			expect(result?.[0][0].json.result).not.toHaveProperty('message');
		});

		it('derives durationMs from the start and end times when the run has no run_duration', async () => {
			const { api, poll } = createContext({ staticData: watchingState() });
			api.mockResolvedValue({ runs: [{ ...failedRun, run_duration: undefined }] });

			const result = await poll();

			expect(result?.[0][0].json.timing).toMatchObject({ durationMs: END_TIME - START_TIME });
		});

		it.each([
			[
				'a failed legacy run',
				{ life_cycle_state: 'TERMINATED', result_state: 'FAILED', state_message: 'boom' },
				{ event: 'runFailed', result: { state: 'TERMINATED', code: 'FAILED', message: 'boom' } },
			],
			[
				'a successful legacy run',
				{ life_cycle_state: 'TERMINATED', result_state: 'SUCCESS' },
				{ event: 'runSucceeded', result: { state: 'TERMINATED', code: 'SUCCESS' } },
			],
			[
				'a skipped legacy run',
				{ life_cycle_state: 'SKIPPED', state_message: 'Run skipped' },
				{
					event: 'runFailed',
					result: { state: 'SKIPPED', code: 'SKIPPED', message: 'Run skipped' },
				},
			],
			[
				'an internal error legacy run',
				{ life_cycle_state: 'INTERNAL_ERROR' },
				{ event: 'runFailed', result: { state: 'INTERNAL_ERROR', code: 'INTERNAL_ERROR' } },
			],
		])('classifies %s from the legacy state fields', async (_label, state, expected) => {
			const { api, poll } = createContext({
				events: ['runFailed', 'runStarted', 'runSucceeded'],
				staticData: watchingState(),
			});
			api.mockResolvedValue({ runs: [{ ...failedRun, status: undefined, state }] });

			const result = await poll();

			expect(result?.[0].map((item) => item.json.event)).toEqual(['runStarted', expected.event]);
			expect(result?.[0][1].json).toMatchObject(expected);
		});

		it('treats a legacy run without a terminal life cycle state as still running', async () => {
			const { api, events } = createContext({
				events: ['runFailed', 'runStarted', 'runSucceeded'],
				staticData: watchingState(),
			});
			api.mockResolvedValue({
				runs: [{ ...runningRun, status: undefined, state: { life_cycle_state: 'RUNNING' } }],
			});

			await expect(events()).resolves.toEqual([{ event: 'runStarted', run: expect.anything() }]);
		});

		it('returns the raw run behind the event label when simplify is off', async () => {
			const { api, poll } = createContext({ simplify: false, staticData: watchingState() });
			api.mockResolvedValue({ runs: [failedRun] });

			await expect(poll()).resolves.toEqual([[{ json: { event: 'runFailed', ...failedRun } }]]);
		});

		it('skips runs without a run ID or start time', async () => {
			const { staticData, api, poll } = createContext({ staticData: watchingState() });
			api.mockResolvedValue({
				runs: [
					{ ...failedRun, run_id: undefined },
					{ ...failedRun, start_time: undefined },
					{ ...runningRun, start_time: 0 },
				],
			});

			await expect(poll()).resolves.toBeNull();
			expect(staticData).toEqual(watchingState());
		});
	});

	describe('run lifecycle across polls', () => {
		it('emits runStarted for a running run only when subscribed', async () => {
			const unsubscribed = createContext({ staticData: watchingState() });
			unsubscribed.api.mockResolvedValue({ runs: [runningRun] });
			await expect(unsubscribed.poll()).resolves.toBeNull();

			const subscribed = createContext({
				events: ['runStarted', 'runSucceeded'],
				staticData: watchingState(),
			});
			subscribed.api.mockResolvedValue({ runs: [runningRun] });
			const result = await subscribed.poll();

			expect(result?.[0]).toHaveLength(1);
			expect(result?.[0][0].json).toEqual({
				event: 'runStarted',
				job: { id: JOB_ID },
				run: simplifiedFailedRun.run,
				timing: { startedAt: '2025-09-01T13:37:18.171Z', queuedMs: 14111 },
			});
			expect(result?.[0][0].json).not.toHaveProperty('result');
			expect(result?.[0][0].json.timing).not.toHaveProperty('endedAt');
			expect(result?.[0][0].json.timing).not.toHaveProperty('durationMs');
		});

		it('emits the terminal event once, without a second runStarted, when a running run finishes', async () => {
			const { staticData, api, events } = createContext({
				events: ['runStarted', 'runSucceeded'],
				staticData: watchingState(),
			});
			api.mockResolvedValueOnce({ runs: [runningRun] });
			await events();
			expect(staticData).toMatchObject({
				cursorMs: START_TIME,
				runs: { [RUN_ID]: { startMs: START_TIME, started: true, terminal: false } },
			});

			api.mockResolvedValueOnce({ runs: [succeededRun] });
			await expect(events()).resolves.toEqual([
				{ event: 'runSucceeded', run: expect.objectContaining({ id: RUN_ID }) },
			]);
			expect(staticData).toMatchObject({
				cursorMs: START_TIME,
				runs: { [RUN_ID]: { startMs: START_TIME, started: true, terminal: true } },
			});

			api.mockResolvedValueOnce({ runs: [succeededRun] });
			await expect(events()).resolves.toEqual([]);
		});

		it('emits runStarted then the terminal event for a run that started and finished between polls', async () => {
			const { api, events } = createContext({
				events: ['runFailed', 'runStarted', 'runSucceeded'],
				staticData: watchingState(),
			});
			api.mockResolvedValue({ runs: [succeededRun] });

			await expect(events()).resolves.toEqual([
				{ event: 'runStarted', run: expect.objectContaining({ id: RUN_ID }) },
				{ event: 'runSucceeded', run: expect.objectContaining({ id: RUN_ID }) },
			]);
		});

		it('does not emit a terminal run again when the overlap window lists it a second time', async () => {
			const { api, poll } = createContext({ staticData: watchingState() });
			api.mockResolvedValue({ runs: [failedRun] });

			await expect(poll()).resolves.toHaveLength(1);
			await expect(poll()).resolves.toBeNull();
			await expect(poll()).resolves.toBeNull();
			expect(api).toHaveBeenCalledTimes(3);
		});

		it('emits several new runs oldest first', async () => {
			const t1 = START_TIME;
			const t2 = START_TIME + 60_000;
			const t3 = START_TIME + 120_000;
			const { api, events } = createContext({ staticData: watchingState() });
			api.mockResolvedValue({ runs: [runAt(3, t3), runAt(1, t1), runAt(2, t2)] });

			const result = await events();

			expect(result.map((item) => item.run)).toEqual([
				expect.objectContaining({ id: 1 }),
				expect.objectContaining({ id: 2 }),
				expect.objectContaining({ id: 3 }),
			]);
		});
	});

	describe('cursor', () => {
		it('never advances past the oldest run that is still in flight', async () => {
			const t1 = START_TIME;
			const t2 = START_TIME + 60_000;
			const { staticData, api, requestQuery, poll } = createContext({
				staticData: watchingState(),
			});
			api.mockResolvedValue({ runs: [runAt(2, t2), runAt(1, t1, runningRun)] });

			await poll();
			expect(staticData).toMatchObject({ cursorMs: t1 });

			await poll();
			expect(requestQuery(1)).toMatchObject({ start_time_from: t1 - OVERLAP_MS });
		});

		it('advances past an in-flight run once it finishes and drops entries the window can no longer list', async () => {
			const t1 = START_TIME;
			const t2 = START_TIME + OVERLAP_MS + 60_000;
			const { staticData, api, poll } = createContext({ staticData: watchingState() });
			api.mockResolvedValueOnce({ runs: [runAt(2, t2), runAt(1, t1, runningRun)] });
			await poll();
			expect(staticData).toMatchObject({ cursorMs: t1 });

			api.mockResolvedValueOnce({ runs: [runAt(2, t2), runAt(1, t1)] });
			await poll();

			expect(staticData).toEqual(
				watchingState({ '2': { startMs: t2, started: true, terminal: true } }, t2),
			);
		});

		it('drops an in-flight run that vanished from the listing and advances the cursor', async () => {
			const t1 = START_TIME;
			const t2 = START_TIME + 60_000;
			const { staticData, api, events } = createContext({
				staticData: watchingState({ '1': { startMs: t1, started: true, terminal: false } }, t1),
			});
			api.mockResolvedValue({ runs: [runAt(2, t2)] });

			await expect(events()).resolves.toEqual([
				{ event: 'runSucceeded', run: expect.objectContaining({ id: 2 }) },
			]);
			expect(staticData).toEqual(
				watchingState({ '2': { startMs: t2, started: true, terminal: true } }, t2),
			);
		});

		it('keeps the listing window above runs it already pruned when the cursor moves back to an in-flight run', async () => {
			const tA = START_TIME - OVERLAP_MS;
			const tB = START_TIME + 60_000;
			const tX = tB - 30_000;
			const { staticData, api, requestQuery, events } = createContext({
				events: ['runFailed', 'runStarted', 'runSucceeded'],
				staticData: watchingState(),
			});
			api.mockResolvedValueOnce({ runs: [runAt(2, tB), runAt(1, tA)] });
			await events();
			expect(staticData).toEqual(
				watchingState({ '2': { startMs: tB, started: true, terminal: true } }, tB),
			);

			api.mockResolvedValueOnce({ runs: [runAt(2, tB), runAt(3, tX, runningRun)] });
			await expect(events()).resolves.toEqual([
				{ event: 'runStarted', run: expect.objectContaining({ id: 3 }) },
			]);
			expect(staticData).toMatchObject({ cursorMs: tX, floorMs: tB - OVERLAP_MS });

			api.mockResolvedValueOnce({ runs: [runAt(2, tB), runAt(3, tX, runningRun)] });
			await expect(events()).resolves.toEqual([]);
			expect(requestQuery(2)).toMatchObject({ start_time_from: tB - OVERLAP_MS });
		});

		it('keeps the cursor when the poll lists no runs', async () => {
			const { staticData, api, poll } = createContext({ staticData: watchingState() });
			api.mockResolvedValue({ runs: [] });

			await expect(poll()).resolves.toBeNull();
			expect(staticData).toEqual(watchingState());
		});

		it('pins the cursor to the oldest listed run and keeps every entry when the listing is truncated', async () => {
			const t1 = START_TIME;
			const t2 = START_TIME + 60_000;
			const stale = { startMs: CURSOR - 2 * OVERLAP_MS, started: true, terminal: false };
			const { context, staticData, api, poll } = createContext({
				staticData: watchingState({ '9': stale }),
			});
			api.mockResolvedValue({ runs: [runAt(2, t2), runAt(1, t1)], next_page_token: 'more' });

			await expect(poll()).resolves.toHaveLength(1);

			expect(api).toHaveBeenCalledTimes(DEFAULT_MAX_PAGES);
			expect(staticData).toEqual(
				watchingState(
					{
						'1': { startMs: t1, started: true, terminal: true },
						'2': { startMs: t2, started: true, terminal: true },
						'9': stale,
					},
					t1,
				),
			);
			expect(context.logger.warn).toHaveBeenCalledTimes(1);
			expect(context.logger.warn).toHaveBeenCalledWith(expect.stringContaining(String(JOB_ID)));
		});
	});

	describe('manual mode', () => {
		it('lists one page without a start time and leaves the static data alone', async () => {
			const { context, staticData, api, requestQuery, events } = createContext({
				mode: 'manual',
				events: ['runFailed', 'runStarted', 'runSucceeded'],
			});
			api.mockResolvedValue({
				runs: [runAt(3, START_TIME + 2000, runningRun), runAt(2, START_TIME + 1000), failedRun],
				next_page_token: 'ignored',
			});

			await expect(events()).resolves.toEqual([
				{ event: 'runFailed', run: expect.objectContaining({ id: RUN_ID }) },
				{ event: 'runSucceeded', run: expect.objectContaining({ id: 2 }) },
				{ event: 'runStarted', run: expect.objectContaining({ id: 3 }) },
			]);
			expect(api).toHaveBeenCalledTimes(1);
			expect(requestQuery()).toEqual({ job_id: JOB_ID, limit: JOB_RUNS_MAX_PAGE_SIZE });
			expect(context.getWorkflowStaticData).not.toHaveBeenCalled();
			expect(staticData).toEqual({});
		});

		it('only returns the subscribed events', async () => {
			const { api, poll } = createContext({ mode: 'manual', events: ['runStarted'] });
			api.mockResolvedValue({ runs: [failedRun, succeededRun] });

			await expect(poll()).resolves.toBeNull();
		});

		it('returns null when the job has no runs', async () => {
			const { api, poll } = createContext({ mode: 'manual' });
			api.mockResolvedValue({ runs: [] });

			await expect(poll()).resolves.toBeNull();
		});
	});

	describe('errors', () => {
		it('explains a PERMISSION_DENIED error with the Can View hint', async () => {
			const { api, poll } = createContext({ staticData: watchingState() });
			api.mockRejectedValue(
				apiErrorFromBody(403, {
					error_code: 'PERMISSION_DENIED',
					message: 'User does not have Can View permission on job 281874479417551.',
				}),
			);

			const error = await poll().catch((thrown: unknown) => thrown);

			expect(error).toBeInstanceOf(NodeApiError);
			expect(error).toMatchObject({
				message: 'User does not have Can View permission on job 281874479417551.',
				description:
					'Grant Can View on the job to the user or service principal of the credential, then retry.',
			});
		});

		it('rethrows other API errors unchanged', async () => {
			const { api, poll } = createContext({ staticData: watchingState() });
			const apiError = apiErrorFromBody(500, { error_code: 'INTERNAL_ERROR', message: 'boom' });
			api.mockRejectedValue(apiError);

			await expect(poll()).rejects.toBe(apiError);
		});

		it.each([
			['a job ID with letters', 'abc', 'Job ID must be a whole number'],
			['an empty job ID', '', 'Job ID must be a whole number'],
			['a job ID above the safe range', '9007199254740993', 'Job ID is too large to send exactly'],
		])('rejects %s before any request', async (_label, jobId, message) => {
			const { staticData, api, poll } = createContext({ jobId, staticData: watchingState() });

			const error = await poll().catch((thrown: unknown) => thrown);

			expect(error).toBeInstanceOf(NodeOperationError);
			expect(error).toMatchObject({ message });
			expect(api).not.toHaveBeenCalled();
			expect(staticData).toEqual(watchingState());
		});

		it.each([
			['a string', 'runFailed'],
			['an unknown event', ['runFailed', 'runCancelled']],
		])('rejects %s as the events parameter', async (_label, events) => {
			const { api, poll } = createContext({ events, staticData: watchingState() });

			await expect(poll()).rejects.toThrow(NodeOperationError);
			expect(api).not.toHaveBeenCalled();
		});
	});
});
