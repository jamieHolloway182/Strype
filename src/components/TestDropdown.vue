<template>
	<div class="dropdown">
		<button class="dropdown-btn" @click="toggleDropdown">
			Select Items
		</button>
		<div class="dropdown-content" v-if="isDropdownVisible">
			<!-- Select All and Reset All buttons -->
			<div class="dropdown-actions">
				<button @click="selectAll">Select All</button>
				<button @click="resetSelection">Reset All</button>
			</div>

			<label v-for="(item, index) in listItems" :key="index">
				<input type="checkbox" :value="item" v-model="selectedItems" />
				{{ item }}
			</label>
		</div>
	</div>
</template>

<script lang="ts">
import Vue from "vue";

export default Vue.extend({
    name: "TestDropdown",

    props: {
        // Accept list of items as a prop from the parent component
        listItems: {
            type: Array as () => string[],
            required: true,
        },
        value: {
            type: Array as () => string[],
            required: true,
        },
    },

    data() {
        return {
            isDropdownVisible: false, // To toggle dropdown visibility
            selectedItems: [...this.value], // Make sure to initialize selectedItems with a copy of the value
        };
    },

    methods: {
        // Toggle visibility of the dropdown
        toggleDropdown() {
            this.isDropdownVisible = !this.isDropdownVisible;
        },

        // Select all items
        selectAll() {
            this.selectedItems = [...this.listItems];
            this.$emit("input", this.selectedItems);  // Emit the updated selectedItems to the parent
        },

        // Reset all selections
        resetSelection() {
            this.selectedItems = [];
            this.$emit("input", this.selectedItems);  // Emit the updated selectedItems to the parent
        },
    },

    watch: {
        // Watch for changes to selectedItems and update the parent
        selectedItems(newVal) {
            this.$emit("input", newVal);  // Emit the updated value to the parent
        },
    },
});
</script>

<style scoped>
	/* Styles for the dropdown */
	.dropdown {
		position: relative;
		display: flex;
        flex-direction: row;
	}

	.dropdown-btn {
		background-color: #3498db;
		color: white;
		padding: 10px;
		border: none;
		cursor: pointer;
		border-radius: 5px;
		margin-top: 20px;
	}

	.dropdown-content {
		background-color: white;
		border: 1px solid #ddd;
		box-shadow: 0px 4px 6px rgba(0, 0, 0, 0.1);
		width: 200px;
		text-align: left;
		padding: 10px;
		border-radius: 5px;
	}

	/* Style the buttons for select all and reset */
	.dropdown-actions {
		display: flex;
		justify-content: space-between;
		margin-bottom: 10px;
	}

	.dropdown-actions button {
		background-color: #3498db;
		color: white;
		border: none;
		cursor: pointer;
		border-radius: 5px;
		padding: 5px 10px;
		font-size: 12px;
	}

	.dropdown-actions button:hover {
		background-color: #2980b9;
	}

	.dropdown-content label {
		display: flex;
		align-items: center;
		padding: 5px;
		cursor: pointer;
	}

	.dropdown-content label:hover {
		background-color: #f0f0f0;
	}

	.dropdown-content input {
		margin-right: 8px;
	}

	/* Show dropdown when visible */
	.dropdown-content[v-show="isDropdownVisible"] {
		display: block;
	}
</style>
