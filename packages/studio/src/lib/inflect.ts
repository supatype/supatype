import pluralizeLib from "pluralize"

/**
 * English inflection for model labels.
 *
 * A model's label comes from its type name, and people name types both ways: `Post` and `Places`,
 * `Child` and `Children`. The library leaves a word alone when it is already in the number asked
 * for, so "Places" stays "Places" rather than becoming "Placeses". It inflects the end of the
 * string, so a whole multi-word label goes in as written: "Child Education Experience" becomes
 * "Child Education Experiences".
 *
 * Two corrections for words a model is likely to be named after, where the library's answer is
 * wrong for a label: "Data" is a mass noun here, not the plural of "Datum", and "Caches" comes from
 * "Cache", not "Cach".
 */
pluralizeLib.addUncountableRule(/data$/i)
pluralizeLib.addSingularRule(/(cach|nich)es$/i, "$1e")

/** "Post" to "Posts"; "Places" and "Children" stay as they are. */
export function pluralize(label: string): string {
  return pluralizeLib.plural(label)
}

/** "Places" to "Place", "Children" to "Child"; "Post" and "Status" stay as they are. */
export function singularize(label: string): string {
  return pluralizeLib.singular(label)
}
