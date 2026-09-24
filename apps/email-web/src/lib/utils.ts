import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

export type WithElementRef<Props, Ref = HTMLElement> = Props & {
	ref?: Ref | null;
};

export type WithoutChild<Props> = Omit<Props, "child">;

export type WithoutChildrenOrChild<Props> = Omit<Props, "children" | "child">;
