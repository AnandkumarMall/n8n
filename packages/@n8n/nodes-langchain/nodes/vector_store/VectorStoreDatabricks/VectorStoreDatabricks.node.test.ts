/* eslint-disable n8n-nodes-base/node-param-display-name-miscased */
/* eslint-disable n8n-nodes-base/node-param-display-name-miscased-id */
import type { Embeddings } from '@langchain/core/embeddings';
import { proxyFetch } from '@n8n/ai-utilities';
import { DATABRICKS_PARTNER_USER_AGENT } from 'n8n-nodes-base/dist/nodes/Databricks/constants';
import { createMockExecuteFunction } from 'n8n-nodes-base/test/nodes/Helpers';
import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INode,
	INodeProperties,
	INodeType,
	ISupplyDataFunctions,
} from 'n8n-workflow';
import type { Mocked } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { getDatabricksTokenProvider } from '../../llms/LmChatDatabricks/token-provider';
import { DatabricksVectorStore } from './DatabricksVectorStore';
import { VectorStoreDatabricks } from './VectorStoreDatabricks.node';

vi.mock('./DatabricksVectorStore', () => ({
	DatabricksVectorStore: { fromExistingIndex: vi.fn(), describeIndex: vi.fn() },
}));
vi.mock('../../llms/LmChatDatabricks/token-provider');
vi.mock('@n8n/ai-utilities', async (importActual) => ({
	...(await importActual()),
	proxyFetch: vi.fn(),
}));

const mockedFromExistingIndex = vi.mocked(DatabricksVectorStore.fromExistingIndex);
const mockedDescribeIndex = vi.mocked(DatabricksVectorStore.describeIndex);

const mockCredential = {
	host: 'https://ws.example.com/',
	grantType: 'clientCredentials',
	clientId: 'test-client-id',
	clientSecret: 'test-client-secret',
	allowedHttpRequestDomains: 'all',
	allowedDomains: '',
};

const nodeDef: INode = {
	id: '1',
	name: 'Databricks Vector Store',
	typeVersion: 1.3,
	type: '@n8n/n8n-nodes-langchain.vectorStoreDatabricks',
	position: [0, 0],
	parameters: {},
};

const baseParams = {
	databricksIndex: { mode: 'list', value: 'cat.sch.idx' },
	contentColumn: 'text',
	options: {},
};

describe('VectorStoreDatabricks', () => {
	let node: VectorStoreDatabricks;
	const methods = new VectorStoreDatabricks().methods as Required<
		NonNullable<INodeType['methods']>
	>;
	let embeddings: ReturnType<typeof mock<Embeddings>>;

	const setupContext = <T extends IExecuteFunctions | ISupplyDataFunctions>(
		params: IDataObject,
		credentialOverrides: Partial<typeof mockCredential> = {},
	) => {
		const ctx = createMockExecuteFunction<T>(params, nodeDef) as Mocked<T>;
		ctx.getCredentials = vi.fn().mockResolvedValue({ ...mockCredential, ...credentialOverrides });
		ctx.getInputData = vi.fn().mockReturnValue([{ json: {} }]);
		ctx.getInputConnectionData = vi.fn().mockResolvedValue(embeddings);
		ctx.logAiEvent = vi.fn();
		return ctx;
	};

	beforeEach(() => {
		vi.clearAllMocks();
		node = new VectorStoreDatabricks();
		embeddings = mock<Embeddings>();
		vi.mocked(getDatabricksTokenProvider).mockReturnValue({
			getToken: vi.fn(async () => 'test-token'),
			expiredStatus: 403,
		});
	});

	describe('description', () => {
		it('is a hidden vector store node with the four default modes', () => {
			expect(node.description).toMatchObject({
				name: 'vectorStoreDatabricks',
				hidden: true,
				credentials: [{ name: 'databricksOAuth2Api', required: true }],
			});
			const mode = node.description.properties.find((p) => p.name === 'mode');
			expect(mode?.options?.map((option) => 'value' in option && option.value)).toEqual([
				'load',
				'insert',
				'retrieve',
				'retrieve-as-tool',
			]);
		});

		it('declares the shared fields', () => {
			const { properties } = node.description;
			const index = properties.find((p) => p.name === 'databricksIndex');
			expect(index?.type).toBe('resourceLocator');
			expect(index?.modes?.[0].typeOptions?.searchListMethod).toBe('searchIndexes');

			const contentColumn = properties.find((p) => p.name === 'contentColumn');
			expect(contentColumn?.typeOptions).toEqual({
				loadOptionsMethod: 'getIndexColumns',
				loadOptionsDependsOn: ['databricksIndex.value'],
			});

			const options = properties.find((p) => p.name === 'options');
			const metadataColumns = (options?.options as INodeProperties[]).find(
				(o) => o.name === 'metadataColumns',
			);
			expect(metadataColumns?.type).toBe('multiOptions');
			expect(metadataColumns?.typeOptions?.loadOptionsMethod).toBe('getIndexColumns');
		});
	});

	describe('supplyData in retrieve mode', () => {
		it('creates the store from the credential host and the shared fields', async () => {
			const store = {};
			mockedFromExistingIndex.mockResolvedValue(store as DatabricksVectorStore);
			const ctx = setupContext<ISupplyDataFunctions>({
				...baseParams,
				mode: 'retrieve',
				options: {
					metadataColumns: ['source'],
					metadata: { metadataValues: [{ name: 'source', value: 'hr' }] },
				},
			});

			const result = await node.supplyData.call(ctx, 0);

			expect(mockedFromExistingIndex).toHaveBeenCalledWith(embeddings, {
				fetch: expect.any(Function),
				host: 'https://ws.example.com',
				indexName: 'cat.sch.idx',
				contentColumn: 'text',
				metadataColumns: ['source'],
				filter: { source: 'hr' },
			});
			expect(result.response).toBeDefined();
		});

		it('rejects an http host before describing the index', async () => {
			const ctx = setupContext<ISupplyDataFunctions>(
				{ ...baseParams, mode: 'retrieve' },
				{ host: 'http://ws.example.com' },
			);

			await expect(node.supplyData.call(ctx, 0)).rejects.toThrow('must use https');
			expect(mockedFromExistingIndex).not.toHaveBeenCalled();
		});

		it('sends the bearer and the partner User-Agent through the store fetch', async () => {
			mockedFromExistingIndex.mockResolvedValue({} as DatabricksVectorStore);
			vi.mocked(proxyFetch).mockResolvedValue(new Response('{}'));
			const ctx = setupContext<ISupplyDataFunctions>({ ...baseParams, mode: 'retrieve' });
			await node.supplyData.call(ctx, 0);

			const { fetch } = mockedFromExistingIndex.mock.calls[0][1];
			await fetch('https://ws.example.com/x');

			const [{ input, init }] = vi.mocked(proxyFetch).mock.calls[0];
			expect(String(input)).toBe('https://ws.example.com/x');
			const headers = new Headers(init?.headers);
			expect(headers.get('authorization')).toBe('Bearer test-token');
			expect(headers.get('user-agent')).toBe(DATABRICKS_PARTNER_USER_AGENT);
		});
	});

	describe('execute in load mode', () => {
		it('searches by text and never embeds the prompt', async () => {
			const doc = { pageContent: 'hello', metadata: { source: 'hr' } };
			const store = { similaritySearchWithScore: vi.fn().mockResolvedValue([[doc, 0.9]]) };
			mockedFromExistingIndex.mockResolvedValue(store as unknown as DatabricksVectorStore);
			const ctx = setupContext<IExecuteFunctions>({
				...baseParams,
				mode: 'load',
				prompt: 'what is up',
				topK: 2,
			});

			const result = await node.execute.call(ctx);

			expect(store.similaritySearchWithScore).toHaveBeenCalledWith('what is up', 2, undefined);
			expect(embeddings.embedQuery).not.toHaveBeenCalled();
			expect(result).toEqual([[{ json: { document: doc, score: 0.9 }, pairedItem: { item: 0 } }]]);
		});
	});

	describe('searchIndexes', () => {
		const pages: Record<string, unknown> = {
			endpoints: { endpoints: [{ name: 'ep1' }, { name: 'ep2' }] },
			'ep1:': { vector_indexes: [{ name: 'cat.sch.zeta', index_type: 'DIRECT_ACCESS' }] },
			'ep2:': {
				vector_indexes: [{ name: 'cat.sch.beta', index_type: 'DELTA_SYNC' }],
				next_page_token: 'p2',
			},
			'ep2:p2': { vector_indexes: [{ name: 'cat.sch.alpha', index_type: 'DELTA_SYNC' }] },
		};

		let httpRequestWithAuthentication: ReturnType<typeof vi.fn>;
		let ctx: ILoadOptionsFunctions;

		const setupSearchContext = (host: string) => {
			httpRequestWithAuthentication = vi.fn(
				async (_type: string, options: { url: string; qs: Record<string, string> }) =>
					options.url.endsWith('/endpoints')
						? pages.endpoints
						: pages[`${options.qs.endpoint_name}:${options.qs.page_token ?? ''}`],
			);
			ctx = {
				getCredentials: vi.fn().mockResolvedValue({ ...mockCredential, host }),
				getNode: vi.fn().mockReturnValue(nodeDef),
				helpers: { httpRequestWithAuthentication },
			} as unknown as ILoadOptionsFunctions;
		};

		it('lists every index of every endpoint, sorted, with the type and endpoint', async () => {
			setupSearchContext('https://ws.example.com/');

			const result = await methods.listSearch.searchIndexes.call(ctx);

			expect(result.results).toEqual([
				{ name: 'cat.sch.alpha', value: 'cat.sch.alpha', description: 'DELTA_SYNC - ep2' },
				{ name: 'cat.sch.beta', value: 'cat.sch.beta', description: 'DELTA_SYNC - ep2' },
				{ name: 'cat.sch.zeta', value: 'cat.sch.zeta', description: 'DIRECT_ACCESS - ep1' },
			]);
			expect(httpRequestWithAuthentication).toHaveBeenCalledTimes(4);
			for (const [type, options] of httpRequestWithAuthentication.mock.calls) {
				expect(type).toBe('databricksOAuth2Api');
				expect(options.url).toMatch(/^https:\/\/ws\.example\.com\/api\/2\.0\/vector-search\//);
				expect(options.headers).toMatchObject({ 'User-Agent': DATABRICKS_PARTNER_USER_AGENT });
			}
		});

		it('applies the substring filter to the name', async () => {
			setupSearchContext('https://ws.example.com');

			const result = await methods.listSearch.searchIndexes.call(ctx, 'ZETA');

			expect(result.results.map((r) => r.value)).toEqual(['cat.sch.zeta']);
		});

		it('rejects an http host before any request', async () => {
			setupSearchContext('http://ws.example.com');

			await expect(methods.listSearch.searchIndexes.call(ctx)).rejects.toThrow('must use https');
			expect(httpRequestWithAuthentication).not.toHaveBeenCalled();
		});
	});

	describe('getIndexColumns', () => {
		const setupLoadOptionsContext = (indexName: string) => {
			const ctx = createMockExecuteFunction<ILoadOptionsFunctions>(
				{},
				nodeDef,
			) as Mocked<ILoadOptionsFunctions>;
			ctx.getCredentials = vi.fn().mockResolvedValue(mockCredential);
			ctx.getCurrentNodeParameter = vi.fn().mockReturnValue(indexName);
			return ctx;
		};

		it('lists the embedding source column first', async () => {
			mockedDescribeIndex.mockResolvedValue({
				name: 'cat.sch.idx',
				primaryKey: 'id',
				indexType: 'DELTA_SYNC',
				embeddingSourceColumn: 'text',
				schemaColumns: ['id', 'text', 'source'],
			});
			const ctx = setupLoadOptionsContext('cat.sch.idx');

			const result = await methods.loadOptions.getIndexColumns.call(ctx);

			expect(mockedDescribeIndex).toHaveBeenCalledWith(
				expect.any(Function),
				'https://ws.example.com',
				'cat.sch.idx',
			);
			expect(ctx.getCurrentNodeParameter).toHaveBeenCalledWith('databricksIndex', {
				extractValue: true,
			});
			expect(result).toEqual([
				{ name: 'text', value: 'text', description: 'Embedding source column' },
				{ name: 'id', value: 'id' },
				{ name: 'source', value: 'source' },
			]);
		});

		it('returns no columns when the index schema is unknown', async () => {
			mockedDescribeIndex.mockResolvedValue({
				name: 'cat.sch.idx',
				primaryKey: 'id',
				indexType: 'DELTA_SYNC',
				vectorColumn: 'embedding',
			});
			const ctx = setupLoadOptionsContext('cat.sch.idx');

			await expect(methods.loadOptions.getIndexColumns.call(ctx)).resolves.toEqual([]);
		});

		it('returns no columns before an index is chosen', async () => {
			const ctx = setupLoadOptionsContext('');

			await expect(methods.loadOptions.getIndexColumns.call(ctx)).resolves.toEqual([]);
			expect(mockedDescribeIndex).not.toHaveBeenCalled();
		});
	});
});
