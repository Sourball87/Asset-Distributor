import React, { createContext, useContext, useEffect, useState } from "react";
import { useGetMe, getGetMeQueryKey, type User } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

type AuthContextType = {
  user: User | null;
  isLoading: boolean;
  setUser: (user: User | null) => void;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { data: user, isLoading, isError } = useGetMe({
    query: {
      queryKey: getGetMeQueryKey(),
      retry: false,
    },
  });

  const [currentUser, setCurrentUser] = useState<User | null>(null);

  useEffect(() => {
    if (user) {
      setCurrentUser(user);
    } else if (isError) {
      setCurrentUser(null);
    }
  }, [user, isError]);

  return (
    <AuthContext.Provider value={{ user: currentUser, isLoading, setUser: setCurrentUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
