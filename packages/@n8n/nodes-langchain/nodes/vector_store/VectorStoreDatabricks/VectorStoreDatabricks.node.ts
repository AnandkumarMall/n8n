import type { Embeddings } from '@langchain/core/embeddings';
import { createVectorStoreNode, proxyFetch } from '@n8n/ai-utilities';
import { DATABRICKS_PARTNER_USER_AGENT } from 'n8n-nodes-base/dist/nodes/Databricks/constants';
import {
	assertParamIsArray,
	assertParamIsString,
	NodeOperationError,
	type IExecuteFunctions,
	type ILoadOptionsFunctions,
	type INodeListSearchResult,
	type INodeProperties,
	type INodePropertyOptions,
	type ISupplyDataFunctions,
} from 'n8n-workflow';

import {
	assertHttpsHost,
	createDatabricksAuthFetch,
	type DatabricksFetchContext,
} from '../../llms/LmChatDatabricks/auth-fetch';
import {
	DATABRICKS_CREDENTIAL_TYPE,
	type DatabricksOAuth2Credential,
} from '../../llms/LmChatDatabricks/token-provider';
import { DatabricksVectorStore } from './DatabricksVectorStore';

const databricksIndexRLC: INodeProperties = {
	displayName: 'Index',
	name: 'databricksIndex',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	required: true,
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			placeholder: 'Select an index...',
			typeOptions: {
				searchListMethod: 'searchIndexes',
				searchable: true,
			},
		},
		{
			displayName: 'Name',
			name: 'id',
			type: 'string',
			placeholder: 'catalog.schema.index',
			validation: [
				{
					type: 'regex',
					properties: {
						regex: '^[^.\\s]+\\.[^.\\s]+\\.[^.\\s]+$',
						errorMessage: 'Use the full name: catalog.schema.index',
					},
				},
			],
		},
	],
};

const columnTypeOptions = {
	loadOptionsMethod: 'getIndexColumns',
	loadOptionsDependsOn: ['databricksIndex.value'],
};

const sharedFields: INodeProperties[] = [
	databricksIndexRLC,
	{
		displayName: 'Content Column',
		name: 'contentColumn',
		type: 'options',
		default: '',
		typeOptions: columnTypeOptions,
		description:
			'Column that becomes the document text. Leave empty on a managed-embedding index to use its embedding source column. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		options: [
			{
				displayName: 'Metadata Columns',
				name: 'metadataColumns',
				type: 'multiOptions',
				default: [],
				typeOptions: columnTypeOptions,
				description:
					'Columns to store in document metadata. Defaults to all columns except the vector column. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
		],
	},
];

// The class owns its HTTP calls, so the runtime and the column dropdown share
// the token-refreshing fetch; the transport goes through the proxy-aware fetch
async function databricksFetch(
	ctx: DatabricksFetchContext,
): Promise<{ fetch: typeof fetch; host: string }> {
	const credential = await ctx.getCredentials<DatabricksOAuth2Credential>(
		DATABRICKS_CREDENTIAL_TYPE,
	);
	assertHttpsHost(ctx, credential.host);
	const host = credential.host.replace(/\/$/, '');
	const egressFilter = ctx.helpers.getSecureEgressFilter();
	const { fetch } = createDatabricksAuthFetch(ctx, credential, {
		endpointUrl: host,
		egressFilter,
		baseFetch: async (input, init) => await proxyFetch({ input, init, egressFilter }),
	});
	return { fetch, host };
}

async function createStore(
	ctx: IExecuteFunctions | ISupplyDataFunctions,
	embeddings: Embeddings,
	itemIndex: number,
	filter?: Record<string, unknown>,
): Promise<DatabricksVectorStore> {
	const { fetch, host } = await databricksFetch(ctx);
	const node = ctx.getNode();
	const indexName = ctx.getNodeParameter('databricksIndex', itemIndex, '', { extractValue: true });
	assertParamIsString('databricksIndex', indexName, node);
	const contentColumn = ctx.getNodeParameter('contentColumn', itemIndex, '');
	assertParamIsString('contentColumn', contentColumn, node);
	const metadataColumns = ctx.getNodeParameter('options.metadataColumns', itemIndex, []);
	assertParamIsArray(
		'metadataColumns',
		metadataColumns,
		(value): value is string => typeof value === 'string',
		node,
	);

	return await DatabricksVectorStore.fromExistingIndex(embeddings, {
		fetch,
		host,
		indexName,
		contentColumn,
		metadataColumns,
		filter,
	});
}

interface ListPage {
	endpoints?: Array<{ name: string }>;
	vector_indexes?: Array<{ name: string; index_type?: string }>;
	next_page_token?: string;
}

async function searchIndexes(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const credentials = await this.getCredentials<DatabricksOAuth2Credential>(
		DATABRICKS_CREDENTIAL_TYPE,
	);
	assertHttpsHost(this, credentials.host);
	const host = credentials.host.replace(/\/$/, '');

	const listPages = async <T>(
		url: string,
		qs: Record<string, string>,
		pick: (page: ListPage) => T[] | undefined,
	): Promise<T[]> => {
		let items: T[] = [];
		let pageToken: string | undefined;
		let pages = 0;
		do {
			// Guard against a host or proxy that echoes the same next_page_token back
			if (++pages > 50) {
				throw new NodeOperationError(this.getNode(), 'Vector search list exceeded 50 pages');
			}
			const page: ListPage = await this.helpers.httpRequestWithAuthentication.call(
				this,
				DATABRICKS_CREDENTIAL_TYPE,
				{
					method: 'GET',
					url,
					qs: { ...qs, page_token: pageToken },
					headers: { Accept: 'application/json', 'User-Agent': DATABRICKS_PARTNER_USER_AGENT },
					json: true,
				},
			);
			items = items.concat(pick(page) ?? []);
			pageToken = page.next_page_token;
		} while (pageToken);
		return items;
	};

	const endpoints = await listPages(
		`${host}/api/2.0/vector-search/endpoints`,
		{},
		(page) => page.endpoints,
	);
	const results = (
		await Promise.all(
			endpoints.map(async (endpoint) => {
				const indexes = await listPages(
					`${host}/api/2.0/vector-search/indexes`,
					{ endpoint_name: endpoint.name },
					(page) => page.vector_indexes,
				);
				// The type tells the user which indexes accept inserts
				return indexes.map((index) => ({
					name: index.name,
					value: index.name,
					description: `${index.index_type} - ${endpoint.name}`,
				}));
			}),
		)
	)
		.flat()
		.sort((a, b) => a.name.localeCompare(b.name));

	const filterLower = filter?.toLowerCase();
	return {
		results: filterLower
			? results.filter((result) => result.name.toLowerCase().includes(filterLower))
			: results,
	};
}

async function getIndexColumns(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const indexName = this.getCurrentNodeParameter('databricksIndex', { extractValue: true });
	if (typeof indexName !== 'string' || indexName === '') return [];

	const { fetch, host } = await databricksFetch(this);
	const info = await DatabricksVectorStore.describeIndex(fetch, host, indexName);
	const source = info.embeddingSourceColumn;
	const columns = (info.schemaColumns ?? [])
		.filter((column) => column !== source)
		.map((column) => ({ name: column, value: column }));
	return source
		? [{ name: source, value: source, description: 'Embedding source column' }, ...columns]
		: columns;
}

export class VectorStoreDatabricks extends createVectorStoreNode<DatabricksVectorStore>({
	meta: {
		displayName: 'Databricks Vector Store',
		name: 'vectorStoreDatabricks',
		description: 'Work with your data in Databricks Vector Search',
		icon: { light: 'file:databricks.svg', dark: 'file:databricks.dark.svg' },
		docsUrl:
			'https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.vectorstoredatabricks/',
		credentials: [
			{
				name: 'databricksOAuth2Api',
				required: true,
			},
		],
	},
	hidden: true,
	// The index decides between query_text and query_vector inside the class
	searchByText: true,
	methods: { listSearch: { searchIndexes }, loadOptions: { getIndexColumns } },
	sharedFields,
	async getVectorStoreClient(context, filter, embeddings, itemIndex) {
		return await createStore(context, embeddings, itemIndex, filter);
	},
	async populateVectorStore(context, embeddings, documents, itemIndex) {
		const store = await createStore(context, embeddings, itemIndex);
		await store.addDocuments(documents);
	},
}) {}
