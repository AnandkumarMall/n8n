import { useTypeAvailabilityPoliciesStore } from '@n8n/frontend-module-type-availability-policies';
import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';

import { mockedStore, type MockedStore } from '@/__tests__/utils';
import { useNodeTypeRestriction } from './useNodeTypeRestriction';

describe('useNodeTypeRestriction', () => {
	let typeAvailabilityPoliciesStore: MockedStore<typeof useTypeAvailabilityPoliciesStore>;

	beforeEach(() => {
		setActivePinia(createTestingPinia());
		typeAvailabilityPoliciesStore = mockedStore(useTypeAvailabilityPoliciesStore);
	});

	it('reports an available type as not restricted', () => {
		typeAvailabilityPoliciesStore.getNodeTypeAvailability.mockReturnValue({
			name: 'n8n-nodes-base.slack',
			available: true,
		});

		const { isRestricted } = useNodeTypeRestriction('n8n-nodes-base.slack');

		expect(isRestricted.value).toBe(false);
	});

	it('describes an instance-scope restriction', () => {
		typeAvailabilityPoliciesStore.getNodeTypeAvailability.mockReturnValue({
			name: 'n8n-nodes-base.slack',
			available: false,
			scope: 'instance',
		});

		const { isRestricted, title } = useNodeTypeRestriction('n8n-nodes-base.slack');

		expect(isRestricted.value).toBe(true);
		expect(title.value).toBe('Restricted on this instance');
	});

	it('describes a project-scope restriction', () => {
		typeAvailabilityPoliciesStore.getNodeTypeAvailability.mockReturnValue({
			name: 'n8n-nodes-base.slack',
			available: false,
			scope: 'project',
		});

		const { title } = useNodeTypeRestriction('n8n-nodes-base.slack');

		expect(title.value).toBe('Restricted in this project');
	});

	it('looks the type up by the current getter value', () => {
		typeAvailabilityPoliciesStore.getNodeTypeAvailability.mockImplementation((name) => ({
			name,
			available: name !== 'n8n-nodes-base.executeCommand',
		}));

		const { isRestricted } = useNodeTypeRestriction(() => 'n8n-nodes-base.executeCommand');

		expect(isRestricted.value).toBe(true);
		expect(typeAvailabilityPoliciesStore.getNodeTypeAvailability).toHaveBeenCalledWith(
			'n8n-nodes-base.executeCommand',
		);
	});
});
