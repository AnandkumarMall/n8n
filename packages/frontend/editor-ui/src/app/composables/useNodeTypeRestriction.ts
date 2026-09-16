import type { NodeTypeAvailability } from '@n8n/api-types';
import { useTypeAvailabilityPoliciesStore } from '@n8n/frontend-module-type-availability-policies';
import { useI18n } from '@n8n/i18n';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';

/**
 * Whether a node type is blocked by a type availability policy in the open workflow's
 * project, plus the copy that explains the restriction to the builder. Pure set-membership
 * rendering off the module store: no policy logic runs client-side.
 */
export function useNodeTypeRestriction(nodeType: MaybeRefOrGetter<string>) {
	const i18n = useI18n();
	const typeAvailabilityPoliciesStore = useTypeAvailabilityPoliciesStore();

	const availability = computed<NodeTypeAvailability>(() =>
		typeAvailabilityPoliciesStore.getNodeTypeAvailability(toValue(nodeType)),
	);

	const isRestricted = computed(() => !availability.value.available);

	const isProjectScope = computed(() => availability.value.scope === 'project');

	/** One line, like the prototype: the scope that blocked the type is the whole explanation. */
	const title = computed(() =>
		i18n.baseText(
			isProjectScope.value ? 'node.restricted.project.title' : 'node.restricted.instance.title',
		),
	);

	return { availability, isRestricted, title };
}
