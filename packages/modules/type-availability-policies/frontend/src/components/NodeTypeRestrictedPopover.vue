<script setup lang="ts">
import type { NodeTypeAvailability } from '@n8n/api-types';
import { N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed } from 'vue';

const props = defineProps<{
	nodeDisplayName: string;
	restriction: NodeTypeAvailability;
}>();

const i18n = useI18n();

// The API carries no reason text, so the copy is derived from the scope that blocked the type.
const copy = computed(() =>
	props.restriction.scope === 'project'
		? {
				title: i18n.baseText('nodeTypeRestricted.project.title'),
				description: i18n.baseText('nodeTypeRestricted.project.description'),
			}
		: {
				title: i18n.baseText('nodeTypeRestricted.instance.title'),
				description: i18n.baseText('nodeTypeRestricted.instance.description'),
			},
);
</script>

<template>
	<div :class="$style.popover" data-test-id="node-type-restricted-popover">
		<N8nText tag="p" size="large" color="text-dark">{{ nodeDisplayName }}</N8nText>
		<N8nText tag="p" size="xsmall" color="text-light" :class="$style.title">{{
			copy.title
		}}</N8nText>
		<N8nText tag="p" size="xsmall" color="text-base" :class="$style.description">
			{{ copy.description }}
		</N8nText>
	</div>
</template>

<style lang="scss" module>
.popover {
	padding: var(--spacing--xs);
	text-align: left;
}

.title {
	margin-top: var(--spacing--4xs);
}

.description {
	margin-top: var(--spacing--3xs);
}
</style>
