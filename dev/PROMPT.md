/brainstorming I want to create a SKILL to use in any project, in order to create a tree of features to develop. This should help in finding dependencies among features and decide wich features can be devleoped in parallel and which are sequential. I want this SKILL to be minimal/simple and implemenmted in nodejs, the name will be "specforest". The workflow should be like:
Step 1 (for each spec file): LLM read the spec file - it finds all the features (branches and sub-branches) - put everything together in a JSON structure and give a name in kebab-case to the spec - if there are no features to implement, the tree must be kept for reference, with just one branch: "verify".
Step 2: LLM must read all the JSON files and find dependencies across features to define a set of dependency islands - I want the LLM to produce  a JSON of the dependency islands.
Step 3: I want to create an MD file for each dependency island, wich will hold the list of features of the island and a wikilink to the spec file where it is defined
Step 4: I want to create a forest.md that holds a wikilink for each dependency island

I want the dependencies to be visibile in obsidian.
I want the behaviour to be configurable, e.g., specs folder by default "docs/specs", output folder "docs/trees", hidden/temp folder ".specforest", config file "specforest.config.yml"
I want also to track the progress of features development
I want a command to print the full forest and single trees in a tree-like ascii representation, similar to directory views. And for each branch i want a sidecar feature counter such as [0/N] representing the features that have been completed agains the fulll number.
The trees should be updated in case of changes in specs files.