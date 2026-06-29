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
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [initialCheckDone, setInitialCheckDone] = useState(false);

  const { data: me, isLoading: queryLoading } = useGetMe({
    query: {
      queryKey: getGetMeQueryKey(),
      retry: false,
      staleTime: 5 * 60 * 1000,
    },
  });

  useEffect(() => {
    if (queryLoading) return;
    if (me) {
      setCurrentUser(me);
    } else if (!initialCheckDone) {
      // Initial check settled with no user — clear state so ProtectedRoute redirects
      setCurrentUser(null);
    }
    setInitialCheckDone(true);
  }, [me, queryLoading, initialCheckDone]);

  return (
    <AuthContext.Provider
      value={{
        user: currentUser,
        isLoading: !initialCheckDone,
        setUser: setCurrentUser,
      }}
    >
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
